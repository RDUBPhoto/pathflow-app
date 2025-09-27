const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

const TABLE = "customers";
const PARTITION = "main";

function pick(v, d = "") { return typeof v === "string" ? v : (v == null ? d : String(v)); }

module.exports = async function (context, req) {
  try {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, headers: { "content-type": "application/json" }, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const client = TableClient.fromConnectionString(conn, TABLE);
    try { await client.createTable(); } catch (_) {}

    const method = (req.method || "GET").toUpperCase();
    const id = context.bindingData && context.bindingData.id ? String(context.bindingData.id) : "";

    if (method === "GET") {
      if (id) {
        const e = await client.getEntity(PARTITION, id);
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { id: e.rowKey, name: pick(e.name), phone: pick(e.phone), email: pick(e.email) } };
        return;
      }
      const out = [];
      const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
      for await (const e of iter) {
        out.push({ id: e.rowKey, name: pick(e.name), phone: pick(e.phone), email: pick(e.email) });
        if (out.length >= 50) break;
      }
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: out };
      return;
    }

    if (method === "POST") {
      const b = req.body || {};
      const rid = pick(b.id) || randomUUID();
      const entity = {
        partitionKey: PARTITION,
        rowKey: rid,
        name: pick(b.name),
        phone: pick(b.phone),
        email: pick(b.email),
        updatedAt: new Date().toISOString()
      };
      await client.upsertEntity(entity, "Merge");
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rid } };
      return;
    }

    context.res = { status: 405, headers: { "content-type": "application/json" }, body: { error: "Method not allowed" } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json" }, body: { error: "Server error", detail: String(err && err.message || err) } };
  }
};
