const { TableClient } = require("../_shared/table-client");
const { randomUUID } = require("crypto");
const { resolveTenantId } = require("../_shared/tenant");
const { requirePrincipal } = require("../_shared/auth");

const TABLE = "vendors";

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asBool(value, fallback = true) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return fallback;
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

function queryParam(req, key) {
  if (req.query && req.query[key] != null) return asString(req.query[key]);
  const rawUrl = asString(req.url);
  if (!rawUrl || rawUrl.indexOf("?") < 0) return "";
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    return asString(parsed.searchParams.get(key));
  } catch {
    return "";
  }
}

function escapedFilterValue(value) {
  return asString(value).replace(/'/g, "''");
}

function normalizeName(value) {
  return asString(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
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

function toVendor(entity) {
  return {
    id: asString(entity.rowKey),
    name: asString(entity.name),
    normalizedName: asString(entity.normalizedName),
    contactName: asString(entity.contactName),
    email: asString(entity.email),
    phone: asString(entity.phone),
    website: asString(entity.website),
    accountNumber: asString(entity.accountNumber),
    notes: asString(entity.notes),
    address: asString(entity.address),
    city: asString(entity.city),
    state: asString(entity.state),
    zip: asString(entity.zip),
    isActive: asBool(entity.isActive, true),
    createdAt: asString(entity.createdAt),
    updatedAt: asString(entity.updatedAt)
  };
}

async function listVendors(client, tenantId) {
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${escapedFilterValue(tenantId)}'` } });
  for await (const entity of iter) out.push(toVendor(entity));
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function matchesQuery(vendor, query) {
  const q = normalizeName(query);
  if (!q) return true;
  const haystack = normalizeName([
    vendor.name,
    vendor.contactName,
    vendor.email,
    vendor.phone,
    vendor.accountNumber
  ].filter(Boolean).join(" "));
  return haystack.includes(q);
}

module.exports = async function (context, req) {
  const method = asString(req.method || "GET").toUpperCase();
  const body = asObject(req.body);
  const tenantId = resolveTenantId(req, body);
  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }
  const principal = await requirePrincipal(context, req);
  if (!principal) return;

  try {
    const client = await getTableClient();

    if (method === "GET") {
      const query = queryParam(req, "q");
      const includeInactive = asBool(queryParam(req, "includeInactive"), false);
      const vendors = (await listVendors(client, tenantId))
        .filter(vendor => includeInactive || vendor.isActive)
        .filter(vendor => matchesQuery(vendor, query));
      context.res = json(200, { ok: true, vendors });
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { error: "Method not allowed" });
      return;
    }

    const op = asString(body.op || body.operation || body.action || "upsert").toLowerCase();
    if (op === "archive" || op === "deactivate") {
      const id = asString(body.id);
      if (!id) {
        context.res = json(400, { error: "id is required." });
        return;
      }
      await client.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: id,
          isActive: false,
          updatedAt: new Date().toISOString()
        },
        "Merge"
      );
      const saved = await client.getEntity(tenantId, id);
      context.res = json(200, { ok: true, vendor: toVendor(saved) });
      return;
    }

    if (op === "create" || op === "upsert" || op === "update") {
      const name = asString(body.name);
      if (!name) {
        context.res = json(400, { error: "name is required." });
        return;
      }
      const normalizedName = normalizeName(name);
      const now = new Date().toISOString();
      const existing = (await listVendors(client, tenantId)).find(vendor => vendor.normalizedName === normalizedName);
      const id = asString(body.id) || (existing && existing.id) || randomUUID();
      const createdAt = asString(body.createdAt) || (existing && existing.createdAt) || now;
      const entity = {
        partitionKey: tenantId,
        rowKey: id,
        name,
        normalizedName,
        contactName: asString(body.contactName),
        email: asString(body.email),
        phone: asString(body.phone),
        website: asString(body.website),
        accountNumber: asString(body.accountNumber),
        notes: asString(body.notes),
        address: asString(body.address),
        city: asString(body.city),
        state: asString(body.state),
        zip: asString(body.zip),
        isActive: asBool(body.isActive, true),
        createdAt,
        updatedAt: now
      };
      await client.upsertEntity(entity, "Merge");
      context.res = json(200, { ok: true, vendor: toVendor({ ...entity, rowKey: id }) });
      return;
    }

    context.res = json(400, { error: "Unknown operation." });
  } catch (err) {
    if (context.log && typeof context.log.error === "function") context.log.error(err);
    context.res = json(500, {
      error: "Server error",
      detail: String((err && err.message) || err)
    });
  }
};
