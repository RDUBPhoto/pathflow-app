const { TableClient } = require("@azure/data-tables");

const TABLE = "lanes";
const PARTITION = "main";
function pick(v, d = "") { return typeof v === "string" ? v : (v == null ? d : String(v)); }
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
  return ["lead", "scheduled", "inprogress", "completed"].includes(String(stageKey || "").trim().toLowerCase());
}
function isProtectedLaneEntity(entity) {
  const stageKey = pick(entity && entity.stageKey).trim().toLowerCase() || inferCoreStageKeyFromName(entity && entity.name);
  return asBool(entity && entity.isSystem) || isCoreStage(stageKey);
}

module.exports = async function (context, req) {
  const method = (req.method || "GET").toUpperCase();
  if (method === "OPTIONS") { context.res = { status: 204 }; return; }

  try {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const client = TableClient.fromConnectionString(conn, TABLE);
    try { await client.createTable(); } catch (_) {}

    const b = req.body || {};
    const id = pick(b.id).trim();
    if (!id) { context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "id required" } }; return; }

    let existing = null;
    try {
      existing = await client.getEntity(PARTITION, id);
    } catch (_) {
      existing = null;
    }
    if (!existing) {
      context.res = { status: 404, headers: { "content-type": "application/json" }, body: { error: "Lane not found" } };
      return;
    }
    if (isProtectedLaneEntity(existing)) {
      context.res = {
        status: 400,
        headers: { "content-type": "application/json" },
        body: { error: "Core workflow lanes cannot be deleted." }
      };
      return;
    }

    await client.deleteEntity(PARTITION, id);
    context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json" }, body: { error: "Server error", detail: String(err && err.message || err) } };
  }
};
