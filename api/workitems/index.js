const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

const T_ITEMS = "workitems";
const T_EVENTS = "events";
const PARTITION = "main";

function pick(v, d = "") { return typeof v === "string" ? v : (v == null ? d : String(v)); }
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

module.exports = async function (context, req) {
  const method = (req.method || "GET").toUpperCase();
  const id = context.bindingData && context.bindingData.id ? String(context.bindingData.id) : "";

  if (method === "OPTIONS") { context.res = { status: 204 }; return; }

  try {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const items = TableClient.fromConnectionString(conn, T_ITEMS);
    const events = TableClient.fromConnectionString(conn, T_EVENTS);
    try { await items.createTable(); } catch (_) {}
    try { await events.createTable(); } catch (_) {}

    if (method === "GET") {
      const laneId = pick(req.query && req.query.laneId);
      const out = [];
      const filter = laneId ? `PartitionKey eq '${PARTITION}' and laneId eq '${laneId.replace(/'/g,"''")}'` : `PartitionKey eq '${PARTITION}'`;
      const iter = items.listEntities({ queryOptions: { filter } });
      for await (const e of iter) {
        out.push({ id: e.rowKey, title: pick(e.title), laneId: pick(e.laneId), customerId: pick(e.customerId), sort: num(e.sort), updatedAt: pick(e.updatedAt) });
      }
      out.sort((a,b) => a.sort - b.sort || String(a.updatedAt).localeCompare(String(b.updatedAt)));
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: out };
      return;
    }

    if (method === "POST" && req.url.includes("/reorder")) {
      const b = req.body || {};
      const laneId = pick(b.laneId);
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
      for (let i = 0; i < ids.length; i++) {
        await items.upsertEntity({ partitionKey: PARTITION, rowKey: ids[i], sort: i * 10, laneId }, "Merge");
      }
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
      return;
    }

    if (method === "POST") {
      const b = req.body || {};
      const rid = pick(b.id);
      const title = pick(b.title).trim();
      const laneId = pick(b.laneId).trim();
      const customerId = pick(b.customerId).trim();

      if (!rid && (!title || !laneId)) { context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "title and laneId required" } }; return; }

      if (!rid) {
        let max = 0;
        const iter = items.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}' and laneId eq '${laneId.replace(/'/g,"''")}'` } });
        for await (const e of iter) max = Math.max(max, num(e.sort));
        const rowKey = randomUUID();
        await items.upsertEntity({ partitionKey: PARTITION, rowKey, title, laneId, customerId, sort: max + 10, updatedAt: new Date().toISOString() }, "Merge");
        await events.upsertEntity({ partitionKey: PARTITION, rowKey: randomUUID(), type: "created", workItemId: rowKey, laneId, at: new Date().toISOString() }, "Merge");
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rowKey } };
        return;
      } else {
        const existing = await items.getEntity(PARTITION, rid);
        const prevLane = pick(existing.laneId);
        const moved = laneId && laneId !== prevLane;
        const patch = { partitionKey: PARTITION, rowKey: rid, updatedAt: new Date().toISOString() };
        if (title) patch.title = title;
        if (laneId) patch.laneId = laneId;
        if (customerId) patch.customerId = customerId;
        await items.upsertEntity(patch, "Merge");
        if (moved) {
          let max = 0;
          const iter = items.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}' and laneId eq '${laneId.replace(/'/g,"''")}'` } });
          for await (const e of iter) max = Math.max(max, num(e.sort));
          await items.upsertEntity({ partitionKey: PARTITION, rowKey: rid, sort: max + 10 }, "Merge");
          await events.upsertEntity({ partitionKey: PARTITION, rowKey: randomUUID(), type: "moved", workItemId: rid, fromLaneId: prevLane, toLaneId: laneId, at: new Date().toISOString() }, "Merge");
        }
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rid, moved } };
        return;
      }
    }

    if (method === "DELETE" && id) {
      await items.deleteEntity(PARTITION, id);
      await events.upsertEntity({ partitionKey: PARTITION, rowKey: randomUUID(), type: "deleted", workItemId: id, at: new Date().toISOString() }, "Merge");
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
      return;
    }

    context.res = { status: 405, headers: { "content-type": "application/json" }, body: { error: "Method not allowed" } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json" }, body: { error: "Server error", detail: String(err && err.message || err) } };
  }
};
