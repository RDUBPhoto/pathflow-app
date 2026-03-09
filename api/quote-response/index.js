const { TableClient } = require("@azure/data-tables");
const { resolveTenantId } = require("../_shared/tenant");

const TABLE = "quoteresponses";

function asString(value) {
  return value == null ? "" : String(value).trim();
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

async function getTableClient() {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn, TABLE);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
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
    const client = await getTableClient();

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

    context.res = json(200, {
      ok: true,
      tenantId,
      quoteId,
      action,
      stage,
      updatedAt: now
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
