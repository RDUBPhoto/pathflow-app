const { TableClient, isSqlBackendEnabled } = require("../_shared/table-client");
const { resolveTenantId, sanitizeTenantId } = require("../_shared/tenant");
const { requirePrincipal } = require("../_shared/auth");
let AzureTableClient = null;
try {
  AzureTableClient = require("@azure/data-tables").TableClient;
} catch (_) {
  AzureTableClient = null;
}

const TABLE = "appsettings";
const ORDERS_INBOX_EMAIL_KEY = "orders.inbox.email";
const DEFAULT_ORDERS_INBOX_DOMAIN = "pathflow-app.com";

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) {}
  }
  return {};
}

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body
  };
}

function parseValue(raw) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function serializeValue(value) {
  return JSON.stringify(value == null ? null : value);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(asString(value));
}

function extractEmailDomain(value) {
  const raw = asString(value);
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at === raw.length - 1) return "";
  return raw.slice(at + 1).trim().toLowerCase();
}

function isValidDomain(value) {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(asString(value));
}

function resolveOrdersInboxDomain() {
  const configuredDomain = asString(process.env.ORDERS_INBOX_DOMAIN).toLowerCase();
  if (isValidDomain(configuredDomain)) return configuredDomain;
  const senderDomain = extractEmailDomain(process.env.EMAIL_FROM);
  if (isValidDomain(senderDomain)) return senderDomain;
  return DEFAULT_ORDERS_INBOX_DOMAIN;
}

function buildOrdersInboxEmail(tenantId) {
  const safeTenant = sanitizeTenantId(tenantId)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "shop";
  return `orders+${safeTenant}@${resolveOrdersInboxDomain()}`;
}

function keyFromRequest(context, req) {
  const routeKey = asString(context && context.bindingData && context.bindingData.key);
  if (routeKey) return routeKey;
  return asString(req && req.query && req.query.key);
}

async function getTableClient() {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn && !isSqlBackendEnabled()) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn || "sql-backend", TABLE);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

async function getLegacyTableClient() {
  if (!isSqlBackendEnabled()) return null;
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn || !AzureTableClient) return null;
  const client = AzureTableClient.fromConnectionString(conn, TABLE);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

async function upsertSetting(client, tenantId, key, value, updatedAt) {
  await client.upsertEntity(
    {
      partitionKey: tenantId,
      rowKey: key,
      valueJson: serializeValue(value),
      updatedAt: asString(updatedAt) || new Date().toISOString()
    },
    "Merge"
  );
}

async function getSetting(client, tenantId, key) {
  const settingKey = asString(key);
  if (!settingKey) return null;
  try {
    const entity = await client.getEntity(tenantId, settingKey);
    return {
      key: settingKey,
      value: parseValue(entity.valueJson),
      updatedAt: asString(entity.updatedAt)
    };
  } catch {
    return null;
  }
}

async function listSettings(client, tenantId) {
  const out = [];
  const safeTenant = asString(tenantId).replace(/'/g, "''");
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${safeTenant}'` } });
  for await (const entity of iter) {
    out.push({
      key: asString(entity.rowKey),
      value: parseValue(entity.valueJson),
      updatedAt: asString(entity.updatedAt)
    });
  }
  out.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return out;
}

module.exports = async function (context, req) {
  const method = asString(req && req.method).toUpperCase() || "GET";
  const body = asObject(req && req.body);
  const tenantId = resolveTenantId(req, body);

  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }
  const principal = await requirePrincipal(context, req);
  if (!principal) return;

  try {
    const client = await getTableClient();
    const legacyClient = await getLegacyTableClient();

    if (method === "GET") {
      const key = keyFromRequest(context, req);
      if (key) {
        let setting = await getSetting(client, tenantId, key);
        if (!setting && legacyClient) {
          setting = await getSetting(legacyClient, tenantId, key);
          if (setting) {
            try {
              await upsertSetting(client, tenantId, key, setting.value, setting.updatedAt);
            } catch (_) {}
          }
        }
        if (!setting) {
          context.res = json(200, { ok: true, tenantId, key, value: null, updatedAt: "" });
          return;
        }
        context.res = json(200, { ok: true, tenantId, ...setting });
        return;
      }

      let items = await listSettings(client, tenantId);
      if (!items.length && legacyClient) {
        items = await listSettings(legacyClient, tenantId);
        for (const item of items) {
          try {
            await upsertSetting(client, tenantId, item.key, item.value, item.updatedAt);
          } catch (_) {}
        }
      }
      context.res = json(200, { ok: true, tenantId, items });
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { error: "Method not allowed" });
      return;
    }

    const op = asString(body.op).toLowerCase() || "set";
    if (op === "ensureordersinboxemail" || op === "ensure-orders-inbox-email") {
      const forceRegenerate = body && (body.force === true || body.force === "true" || body.force === 1 || body.force === "1");
      const existing = await getSetting(client, tenantId, ORDERS_INBOX_EMAIL_KEY);
      const existingValue = asString(existing && existing.value).toLowerCase();

      if (!forceRegenerate && isValidEmail(existingValue)) {
        context.res = json(200, {
          ok: true,
          tenantId,
          key: ORDERS_INBOX_EMAIL_KEY,
          value: existingValue,
          updatedAt: asString(existing.updatedAt),
          created: false,
          regenerated: false,
          domain: resolveOrdersInboxDomain()
        });
        return;
      }

      const generated = buildOrdersInboxEmail(tenantId);
      const now = new Date().toISOString();
      await upsertSetting(client, tenantId, ORDERS_INBOX_EMAIL_KEY, generated, now);
      if (legacyClient) {
        try {
          await upsertSetting(legacyClient, tenantId, ORDERS_INBOX_EMAIL_KEY, generated, now);
        } catch (_) {}
      }
      context.res = json(200, {
        ok: true,
        tenantId,
        key: ORDERS_INBOX_EMAIL_KEY,
        value: generated,
        updatedAt: now,
        created: true,
        regenerated: !!forceRegenerate,
        domain: resolveOrdersInboxDomain()
      });
      return;
    }

    const key = asString(body.key || keyFromRequest(context, req));
    if (!key) {
      context.res = json(400, { error: "key is required." });
      return;
    }

    if (op === "delete" || op === "remove") {
      try {
        await client.deleteEntity(tenantId, key);
      } catch (_) {}
      if (legacyClient) {
        try {
          await legacyClient.deleteEntity(tenantId, key);
        } catch (_) {}
      }
      context.res = json(200, { ok: true, tenantId, key, deleted: true });
      return;
    }

    const now = new Date().toISOString();
    await upsertSetting(client, tenantId, key, body.value, now);
    if (legacyClient) {
      try {
        await upsertSetting(legacyClient, tenantId, key, body.value, now);
      } catch (_) {}
    }

    context.res = json(200, {
      ok: true,
      tenantId,
      key,
      value: body.value == null ? null : body.value,
      updatedAt: now
    });
  } catch (err) {
    context.log.error(err);
    context.res = json(500, {
      error: "Server error",
      detail: String((err && err.message) || err)
    });
  }
};
