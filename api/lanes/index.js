const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

const TABLE = "lanes";
const PARTITION = "main";

function pick(v, d = "") { return typeof v === "string" ? v : (v == null ? d : String(v)); }
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

module.exports = async function (context, req) {
  const method = (req.method || "GET").toUpperCase();
  const action = context.bindingData && context.bindingData.action ? String(context.bindingData.action) : "";
  const id = context.bindingData && context.bindingData.id ? String(context.bindingData.id) : "";

  if (method === "OPTIONS") { context.res = { status: 204 }; return; }

  try {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const client = TableClient.fromConnectionString(conn, TABLE);
    try { await client.createTable(); } catch (_) {}

    if (method === "GET") {
      const out = [];
      const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
      for await (const e of iter) out.push({ id: e.rowKey, name: pick(e.name), sort: num(e.sort) });
      out.sort((a,b) => a.sort - b.sort || a.name.localeCompare(b.name));
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: out };
      return;
    }

    if (method === "POST" && action === "reorder") {
      const body = req.body || {};
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      for (let i = 0; i < ids.length; i++) {
        const rowKey = ids[i];
        await client.upsertEntity({ partitionKey: PARTITION, rowKey, sort: i * 10 }, "Merge");
      }
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
      return;
    }

    if (method === "POST") {
      const b = req.body || {};
      const rid = pick(b.id);
      const name = pick(b.name).trim();
      if (!rid && !name) { context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "name required" } }; return; }

      if (!rid) {
        let max = 0;
        const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
        for await (const e of iter) max = Math.max(max, num(e.sort));
        const rowKey = randomUUID();
        await client.upsertEntity({ partitionKey: PARTITION, rowKey, name, sort: max + 10 }, "Merge");
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rowKey } };
        return;
      } else {
        await client.upsertEntity({ partitionKey: PARTITION, rowKey: rid, name }, "Merge");
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rid } };
        return;
      }
    }

    if (method === "DELETE" && id) {
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