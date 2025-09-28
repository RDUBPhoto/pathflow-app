const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

const TABLE = "customers";
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

    if (method === "GET") {
      const out = [];
      const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
      for await (const e of iter) out.push({ id: e.rowKey, name: pick(e.name), phone: pick(e.phone), email: pick(e.email) });
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: out };
      return;
    }

    if (method === "POST") {
      const b = req.body || {};
      const op = String(b.op || "").toLowerCase();
      const id = pick(b.id);
      if (op === "delete" && id) {
        await client.deleteEntity(PARTITION, id);
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
        return;
      }

      const name = pick(b.name).trim();
      const phone = pick(b.phone).trim();
      const email = pick(b.email).trim();

      if (!id && !name) { context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "name required" } }; return; }

      if (!id) {
        const rowKey = randomUUID();
        await client.upsertEntity({ partitionKey: PARTITION, rowKey, name, phone, email }, "Merge");
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rowKey } };
        return;
      } else {
        const patch = { partitionKey: PARTITION, rowKey: id };
        if (name) patch.name = name;
        if (phone || b.hasOwnProperty("phone")) patch.phone = phone;
        if (email || b.hasOwnProperty("email")) patch.email = email;
        await client.upsertEntity(patch, "Merge");
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id } };
        return;
      }
    }

    context.res = { status: 405, headers: { "content-type": "application/json" }, body: { error: "Method not allowed" } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json" }, body: { error: "Server error", detail: String(err && err.message || err) } };
  }
};
