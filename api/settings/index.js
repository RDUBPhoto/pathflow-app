const { TableClient, isSqlBackendEnabled } = require("../_shared/table-client");
const { resolveTenantId } = require("../_shared/tenant");
const { requirePrincipal } = require("../_shared/auth");
let AzureTableClient = null;
try {
  AzureTableClient = require("@azure/data-tables").TableClient;
} catch (_) {
  AzureTableClient = null;
}

const TABLE = "appsettings";

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
