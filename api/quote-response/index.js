const { TableClient } = require("@azure/data-tables");
const { resolveTenantId } = require("../_shared/tenant");

const TABLE = "quoteresponses";
const NOTIFICATIONS_TABLE = "notifications";
const USERS_TABLE = "useraccess";
const USERS_PARTITION = "v1";

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asBool(value) {
  if (typeof value === "boolean") return value;
  const lowered = asString(value).toLowerCase();
  return lowered === "true" || lowered === "1" || lowered === "yes";
}

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body
  };
}

function readHeader(headers, key) {
  if (!headers || typeof headers !== "object") return "";
  const direct = headers[key];
  if (direct != null) return asString(direct);
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (String(name || "").toLowerCase() !== lower) continue;
    return asString(value);
  }
  return "";
}

function normalizeEmail(value) {
  return asString(value).toLowerCase();
}

function parseJson(value, fallback) {
  const raw = asString(value);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function escapedFilterValue(value) {
  return asString(value).replace(/'/g, "''");
}

function hasAuthenticatedPrincipal(req) {
  const principal = readHeader(req && req.headers, "x-ms-client-principal");
  return !!principal;
}

function normalizeAction(value) {
  const action = asString(value).toLowerCase();
  if (action === "accept" || action === "accepted") return "accept";
  if (action === "decline" || action === "declined") return "decline";
  return "";
}

function rowKeyForNotification(quoteId, stage, recipientKey) {
  return String(`quote-${quoteId}-${stage}-${recipientKey}`)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 220);
}

function parseUserLocationIds(userEntity) {
  const parsed = parseJson(userEntity && userEntity.locationIdsJson, []);
  const out = new Set();
  for (const item of Array.isArray(parsed) ? parsed : []) {
    const id = asString(item).toLowerCase();
    if (!id) continue;
    out.add(id);
  }
  return Array.from(out);
}

function userCanAccessTenant(userEntity, tenantId) {
  if (asBool(userEntity && userEntity.allLocations)) return true;
  if (asBool(userEntity && userEntity.isSuperAdmin)) return true;
  const locations = parseUserLocationIds(userEntity);
  if (!locations.length) return true;
  return locations.includes(asString(tenantId).toLowerCase());
}

async function getTableClient(tableName) {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn, tableName);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

async function listTenantRecipients(userClient, tenantId) {
  const out = [];
  const seen = new Set();
  const filter = `PartitionKey eq '${escapedFilterValue(USERS_PARTITION)}'`;
  const iter = userClient.listEntities({ queryOptions: { filter } });
  for await (const entity of iter) {
    if (!userCanAccessTenant(entity, tenantId)) continue;
    const userId = asString(entity.userId || entity.rowKey);
    const email = normalizeEmail(entity.email || entity.rowKey);
    if (!userId && !email) continue;
    const dedupe = `${userId}|${email}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      targetUserId: userId,
      targetEmail: email,
      targetDisplayName: asString(entity.displayName || email || userId)
    });
  }
  return out;
}

async function createQuoteAcceptedNotifications(notificationClient, userClient, tenantId, payload) {
  const quoteId = asString(payload.quoteId);
  if (!quoteId) return 0;
  const recipients = await listTenantRecipients(userClient, tenantId);
  if (!recipients.length) return 0;

  const quoteNumber = asString(payload.quoteNumber) || quoteId;
  const customerName = asString(payload.customerName) || "Customer";
  const nowIso = new Date().toISOString();
  let count = 0;

  for (const recipient of recipients) {
    const recipientKey = asString(recipient.targetEmail || recipient.targetUserId);
    if (!recipientKey) continue;
    const rowKey = rowKeyForNotification(quoteId, "accepted", recipientKey);
    await notificationClient.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey,
        type: "quote-response",
        title: `Quote ${quoteNumber} accepted`,
        message: `${customerName} accepted quote ${quoteNumber}.`,
        route: `/invoices/${encodeURIComponent(quoteId)}`,
        entityType: "quote",
        entityId: quoteId,
        metadataJson: JSON.stringify({
          quoteId,
          quoteNumber,
          customerName,
          action: "accept",
          source: "public-quote-link"
        }),
        targetUserId: asString(recipient.targetUserId),
        targetEmail: normalizeEmail(recipient.targetEmail),
        targetDisplayName: asString(recipient.targetDisplayName),
        actorUserId: "",
        actorEmail: "",
        actorDisplayName: "Customer",
        read: false,
        readAt: "",
        createdAt: nowIso,
        updatedAt: nowIso
      },
      "Merge"
    );
    count += 1;
  }

  return count;
}

module.exports = async function (context, req) {
  const method = asString(req && req.method).toUpperCase() || "GET";
  const body = req && req.body && typeof req.body === "object" ? req.body : {};
  const tenantId = resolveTenantId(req, body);

  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }

  try {
    const client = await getTableClient(TABLE);
    const notificationClient = await getTableClient(NOTIFICATIONS_TABLE);
    const userClient = await getTableClient(USERS_TABLE);

    if (method === "GET") {
      if (!hasAuthenticatedPrincipal(req)) {
        context.res = json(401, { ok: false, error: "Authentication required." });
        return;
      }

      const quoteId = asString(req && req.query && req.query.quoteId);
      if (quoteId) {
        try {
          const item = await client.getEntity(tenantId, quoteId);
          context.res = json(200, {
            ok: true,
            tenantId,
            item: {
              quoteId,
              action: asString(item.action),
              stage: asString(item.stage),
              quoteNumber: asString(item.quoteNumber),
              updatedAt: asString(item.updatedAt)
            }
          });
          return;
        } catch {
          context.res = json(200, { ok: true, tenantId, item: null });
          return;
        }
      }

      const limitRaw = Number(req && req.query && req.query.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 200;
      const safeTenant = asString(tenantId).replace(/'/g, "''");
      const out = [];
      const iter = client.listEntities({
        queryOptions: { filter: `PartitionKey eq '${safeTenant}'` }
      });
      for await (const entity of iter) {
        out.push({
          quoteId: asString(entity.rowKey),
          action: asString(entity.action),
          stage: asString(entity.stage),
          quoteNumber: asString(entity.quoteNumber),
          updatedAt: asString(entity.updatedAt)
        });
      }
      out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      context.res = json(200, { ok: true, tenantId, items: out.slice(0, limit) });
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { ok: false, error: "Method not allowed." });
      return;
    }

    const quoteId = asString(body.quoteId || body.id);
    const action = normalizeAction(body.action);
    if (!quoteId) {
      context.res = json(400, { ok: false, error: "quoteId is required." });
      return;
    }
    if (!action) {
      context.res = json(400, { ok: false, error: "action must be `accept` or `decline`." });
      return;
    }

    const now = new Date().toISOString();
    const stage = action === "accept" ? "accepted" : "declined";
    await client.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey: quoteId,
        quoteId,
        action,
        stage,
        quoteNumber: asString(body.quoteNumber),
        customerName: asString(body.customerName),
        vehicle: asString(body.vehicle),
        businessName: asString(body.businessName),
        updatedAt: now
      },
      "Merge"
    );

    let notificationsCreated = 0;
    if (action === "accept") {
      notificationsCreated = await createQuoteAcceptedNotifications(notificationClient, userClient, tenantId, {
        quoteId,
        quoteNumber: asString(body.quoteNumber),
        customerName: asString(body.customerName)
      });
    }

    context.res = json(200, {
      ok: true,
      tenantId,
      quoteId,
      action,
      stage,
      updatedAt: now,
      notificationsCreated
    });
  } catch (err) {
    context.log.error(err);
    context.res = json(500, {
      ok: false,
      error: "Server error.",
      detail: String((err && err.message) || err)
    });
  }
};
