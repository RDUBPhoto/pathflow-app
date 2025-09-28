const { TableClient } = require("@azure/data-tables");

const TABLE = "lanes";
const PARTITION = "main";
function pick(v, d = "") { return typeof v === "string" ? v : (v == null ? d : String(v)); }

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

    await client.deleteEntity(PARTITION, id);
    context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json" }, body: { error: "Server error", detail: String(err && err.message || err) } };
  }
};
