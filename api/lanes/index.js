const { TableClient } = require("../_shared/table-client");
const { randomUUID } = require("crypto");
const { resolveTenantId } = require("../_shared/tenant");
const { requirePrincipal } = require("../_shared/auth");

const TABLE = "lanes";

const CORE_LANES = [
  { stageKey: "lead", name: "Leads", sort: 100 },
  { stageKey: "quote", name: "Quotes", sort: 200 },
  { stageKey: "invoiced", name: "Invoices", sort: 300 },
  { stageKey: "scheduled", name: "Scheduled", sort: 400 },
  { stageKey: "inprogress", name: "In-Progress", sort: 500 },
  { stageKey: "completed", name: "Completed", sort: 600 }
];

function pick(v, d = "") { return typeof v === "string" ? v : (v == null ? d : String(v)); }
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function asBool(v) {
  if (v === true || v === 1 || v === "1") return true;
  const s = pick(v).trim().toLowerCase();
  return s === "true" || s === "yes" || s === "y" || s === "on";
}

function inferCoreStageKeyFromName(name) {
  const n = pick(name).trim().toLowerCase();
  if (!n) return "custom";
  if (/^leads?$/.test(n)) return "lead";
  if (/^quotes?$/.test(n) || /^estimates?$/.test(n)) return "quote";
  if (/^scheduled$/.test(n)) return "scheduled";
  if (/^work in[- ]?progress$/.test(n) || /^in[- ]?progress$/.test(n)) return "inprogress";
  if (/^invoiced$/.test(n) || /^invoices$/.test(n) || /^invoice$/.test(n)) return "invoiced";
  if (/^completed$/.test(n)) return "completed";
  return "custom";
}

function isCoreStage(stageKey) {
  return CORE_LANES.some(lane => lane.stageKey === stageKey);
}

function laneFromEntity(entity) {
  const stageKey = pick(entity.stageKey).trim().toLowerCase() || "custom";
  const isSystem = asBool(entity.isSystem) || isCoreStage(stageKey);
  return {
    id: entity.rowKey,
    name: pick(entity.name).trim(),
    sort: num(entity.sort),
    stageKey,
    protected: isSystem
  };
}

async function listLaneEntities(client, tenantId) {
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${tenantId}'` } });
  for await (const entity of iter) {
    out.push(entity);
  }
  return out;
}

async function ensureCoreLanes(client, lanes, tenantId) {
  const byStage = new Map();
  for (const entity of lanes) {
    const stageKey = pick(entity.stageKey).trim().toLowerCase() || inferCoreStageKeyFromName(entity.name);
    if (isCoreStage(stageKey) && !byStage.has(stageKey)) {
      byStage.set(stageKey, entity);
    }
  }

  for (const core of CORE_LANES) {
    const existing = byStage.get(core.stageKey);
    if (!existing) {
      const created = {
        partitionKey: tenantId,
        rowKey: randomUUID(),
        name: core.name,
        sort: core.sort,
        stageKey: core.stageKey,
        isSystem: true
      };
      await client.upsertEntity(created, "Merge");
      lanes.push(created);
      byStage.set(core.stageKey, created);
      continue;
    }

    const needsPatch =
      pick(existing.name).trim() !== core.name ||
      num(existing.sort) !== core.sort ||
      pick(existing.stageKey).trim().toLowerCase() !== core.stageKey ||
      !asBool(existing.isSystem);
    if (needsPatch) {
      await client.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: existing.rowKey,
          name: core.name,
          sort: core.sort,
          stageKey: core.stageKey,
          isSystem: true
        },
        "Merge"
      );
      existing.name = core.name;
      existing.sort = core.sort;
      existing.stageKey = core.stageKey;
      existing.isSystem = true;
    }
  }
}

async function getLaneById(client, laneId, tenantId) {
  if (!laneId) return null;
  try {
    const entity = await client.getEntity(tenantId, laneId);
    return entity || null;
  } catch (_) {
    return null;
  }
}

function isProtectedLaneEntity(entity) {
  if (!entity) return false;
  const stageKey = pick(entity.stageKey).trim().toLowerCase() || inferCoreStageKeyFromName(entity.name);
  return asBool(entity.isSystem) || isCoreStage(stageKey);
}

module.exports = async function (context, req) {
  const method = (req.method || "GET").toUpperCase();
  const id = context.bindingData && context.bindingData.id ? String(context.bindingData.id) : "";
  const tenantId = resolveTenantId(req, req && req.body ? req.body : {});

  if (method === "OPTIONS") { context.res = { status: 204 }; return; }
  const principal = await requirePrincipal(context, req);
  if (!principal) return;

  try {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const client = TableClient.fromConnectionString(conn, TABLE);
    try { await client.createTable(); } catch (_) {}

    if (method === "GET") {
      const entities = await listLaneEntities(client, tenantId);
      await ensureCoreLanes(client, entities, tenantId);
      const out = entities
        .map(laneFromEntity)
        .filter(lane => !!lane.name && isCoreStage(lane.stageKey));
      out.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: out };
      return;
    }

    if (method === "POST") {
      const b = req.body || {};
      const rid = pick(b.id);
      const hasName = Object.prototype.hasOwnProperty.call(b, "name");
      const name = hasName ? pick(b.name).trim() : "";

      if (!rid && !hasName) {
        context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "name required" } };
        return;
      }

      if (!rid) {
        context.res = {
          status: 400,
          headers: { "content-type": "application/json" },
          body: { error: "Workflow lanes are locked and cannot be added." }
        };
        return;
      }

      const existing = await getLaneById(client, rid, tenantId);
      if (!existing) {
        context.res = { status: 404, headers: { "content-type": "application/json" }, body: { error: "Lane not found" } };
        return;
      }

      context.res = {
        status: 400,
        headers: { "content-type": "application/json" },
        body: { error: "Workflow lanes are locked and cannot be modified." }
      };
      return;
    }

    if (method === "DELETE" && id) {
      context.res = {
        status: 400,
        headers: { "content-type": "application/json" },
        body: { error: "Workflow lanes are locked and cannot be deleted." }
      };
      return;
    }

    context.res = { status: 405, headers: { "content-type": "application/json" }, body: { error: "Method not allowed" } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json" }, body: { error: "Server error", detail: String(err && err.message || err) } };
  }
};
