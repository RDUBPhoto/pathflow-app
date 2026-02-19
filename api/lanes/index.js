const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

const TABLE = "lanes";
const PARTITION = "main";

const CORE_LANES = [
  { stageKey: "lead", name: "Leads", sort: 100 },
  { stageKey: "scheduled", name: "Scheduled", sort: 200 },
  { stageKey: "inprogress", name: "Work In-Progress", sort: 300 },
  { stageKey: "completed", name: "Completed", sort: 400 }
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
  if (/^scheduled$/.test(n)) return "scheduled";
  if (/^work in[- ]?progress$/.test(n) || /^in[- ]?progress$/.test(n)) return "inprogress";
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

async function listLaneEntities(client) {
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
  for await (const entity of iter) {
    out.push(entity);
  }
  return out;
}

async function ensureCoreLanes(client, lanes) {
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
        partitionKey: PARTITION,
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
      pick(existing.stageKey).trim().toLowerCase() !== core.stageKey ||
      !asBool(existing.isSystem);
    if (needsPatch) {
      await client.upsertEntity(
        {
          partitionKey: PARTITION,
          rowKey: existing.rowKey,
          stageKey: core.stageKey,
          isSystem: true
        },
        "Merge"
      );
      existing.stageKey = core.stageKey;
      existing.isSystem = true;
    }
  }
}

async function getLaneById(client, laneId) {
  if (!laneId) return null;
  try {
    const entity = await client.getEntity(PARTITION, laneId);
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

  if (method === "OPTIONS") { context.res = { status: 204 }; return; }

  try {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const client = TableClient.fromConnectionString(conn, TABLE);
    try { await client.createTable(); } catch (_) {}

    if (method === "GET") {
      const entities = await listLaneEntities(client);
      await ensureCoreLanes(client, entities);
      const out = entities
        .map(laneFromEntity)
        .filter(lane => !!lane.name);
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
        let max = 0;
        const entities = await listLaneEntities(client);
        for (const entity of entities) max = Math.max(max, num(entity.sort));
        const rowKey = randomUUID();
        await client.upsertEntity(
          {
            partitionKey: PARTITION,
            rowKey,
            name,
            sort: max + 10,
            stageKey: "custom",
            isSystem: false
          },
          "Merge"
        );
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rowKey } };
        return;
      }

      const existing = await getLaneById(client, rid);
      if (!existing) {
        context.res = { status: 404, headers: { "content-type": "application/json" }, body: { error: "Lane not found" } };
        return;
      }

      const isProtected = isProtectedLaneEntity(existing);
      if (hasName && name === "") {
        if (isProtected) {
          context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "Core workflow lanes cannot be deleted." } };
          return;
        }
        await client.deleteEntity(PARTITION, rid);
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
        return;
      }

      if (hasName && name && isProtected) {
        context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "Core workflow lanes cannot be renamed." } };
        return;
      }

      const patch = { partitionKey: PARTITION, rowKey: rid };
      if (hasName && name) patch.name = name;
      await client.upsertEntity(patch, "Merge");
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rid } };
      return;
    }

    if (method === "DELETE" && id) {
      const existing = await getLaneById(client, id);
      if (!existing) {
        context.res = { status: 404, headers: { "content-type": "application/json" }, body: { error: "Lane not found" } };
        return;
      }
      if (isProtectedLaneEntity(existing)) {
        context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "Core workflow lanes cannot be deleted." } };
        return;
      }
      await client.deleteEntity(PARTITION, id);
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
      return;
    }

    context.res = { status: 405, headers: { "content-type": "application/json" }, body: { error: "Method not allowed" } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json" }, body: { error: "Server error", detail: String(err && err.message || err) } };
  }
};
