const { TableClient } = require("@azure/data-tables");

const TABLE = "lanes";
const PARTITION = "main";

function isArr(a) { return Array.isArray(a); }
function str(v) { return typeof v === "string" ? v : String(v ?? ""); }

module.exports = async function (context, req) {
  const m = (req.method || "GET").toUpperCase();
  if (m === "OPTIONS") { context.res = { status: 204 }; return; }

  try {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const client = TableClient.fromConnectionString(conn, TABLE);
    try { await client.createTable(); } catch (_) {}

    const b = req.body || {};
    const ids = isArr(b.ids) ? b.ids.map(str) : [];
    for (let i = 0; i < ids.length; i++) {
      const rowKey = ids[i];
      await client.upsertEntity({ partitionKey: PARTITION, rowKey, sort: i * 10 }, "Merge");
    }

    context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json" }, body: { error: "Server error", detail: String(err && err.message || err) } };
  }
};