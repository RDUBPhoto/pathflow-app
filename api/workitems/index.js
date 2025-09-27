const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

const T_ITEMS = "workitems";
const T_EVENTS = "events";
const T_CUSTOMERS = "customers";
const PARTITION = "main";

function pick(v, d = "") { return typeof v === "string" ? v : (v == null ? d : String(v)); }
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function kindOf(name) {
  const s = String(name || "").toLowerCase();
  if (/quote/.test(s)) return "quote";
  if (/sched/.test(s)) return "scheduled";
  if (/progress|in[- ]?progress/.test(s)) return "inprogress";
  if (/ready|pickup|complete|completed|done/.test(s)) return "completed";
  if (/lead/.test(s)) return "lead";
  if (/invoice|invoiced|paid/.test(s)) return "invoiced";
  return "other";
}

async function notify(context, laneName, workItem, customer) {
  const k = kindOf(laneName);
  const email = pick(customer && customer.email);
  const phone = pick(customer && customer.phone);
  const name = pick(customer && customer.name);
  const title = pick(workItem && workItem.title);

  let subj = "";
  let body = "";
  let sms = "";

  if (k === "quote") {
    subj = "Your quote is ready";
    body = `Hi ${name || "there"}, your quote for "${title}" is ready. Reply to confirm or ask questions.`;
    sms = `Your quote for "${title}" is ready. Check your email for details.`;
  } else if (k === "scheduled") {
    subj = "You're scheduled";
    body = `Hi ${name || "there"}, your vehicle is scheduled for "${title}". We'll send drop-off instructions soon.`;
    sms = `You're scheduled for "${title}". Watch for drop-off instructions.`;
  } else if (k === "inprogress") {
    subj = "Work in progress";
    body = `Update: "${title}" is now in progress. We'll keep you posted.`;
    sms = `Update: "${title}" is now in progress.`;
  } else if (k === "completed") {
    subj = "Ready for pickup";
    body = `Great news: "${title}" is complete and ready for pickup. Reply to confirm a time.`;
    sms = `"${title}" is complete and ready for pickup.`;
  } else if (k === "invoiced") {
    subj = "Invoice available";
    body = `Your invoice for "${title}" is ready. You can pay online via the link provided.`;
    sms = `Invoice for "${title}" is ready. Check your email for the link.`;
  } else {
    return;
  }

  if (email) await sendEmail(context, email, subj, body);
  if (phone) await sendSms(context, phone, sms);
}

async function sendEmail(context, to, subject, text) {
  const key = process.env.SENDGRID_API_KEY;
  const from = process.env.FROM_EMAIL;
  if (!key || !from) return;
  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from }, subject, content: [{ type: "text/plain", value: text }] })
    });
    context.log(`sendgrid ${res.status}`);
  } catch (e) {
    context.log(`sendgrid error ${String(e)}`);
  }
}

async function sendSms(context, to, text) {
  const sid = process.env.TWILIO_SID;
  const token = process.env.TWILIO_TOKEN;
  const from = process.env.FROM_PHONE;
  if (!sid || !token || !from) return;
  const body = new URLSearchParams({ From: from, To: to, Body: text });
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: { "Authorization": "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    context.log(`twilio ${res.status}`);
  } catch (e) {
    context.log(`twilio error ${String(e)}`);
  }
}

module.exports = async function (context, req) {
  const method = (req.method || "GET").toUpperCase();
  const id = context.bindingData && context.bindingData.id ? String(context.bindingData.id) : "";

  if (method === "OPTIONS") { context.res = { status: 204 }; return; }

  try {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const items = TableClient.fromConnectionString(conn, T_ITEMS);
    const events = TableClient.fromConnectionString(conn, T_EVENTS);
    const customers = TableClient.fromConnectionString(conn, T_CUSTOMERS);
    try { await items.createTable(); } catch (_) {}
    try { await events.createTable(); } catch (_) {}

    if (method === "GET") {
      const laneId = pick(req.query && req.query.laneId);
      const out = [];
      const filter = laneId ? `PartitionKey eq '${PARTITION}' and laneId eq '${laneId.replace(/'/g,"''")}'` : `PartitionKey eq '${PARTITION}'`;
      const iter = items.listEntities({ queryOptions: { filter } });
      for await (const e of iter) {
        const createdAt = pick(e.createdAt) || (e.timestamp ? new Date(e.timestamp).toISOString() : "");
        out.push({ id: e.rowKey, title: pick(e.title), laneId: pick(e.laneId), customerId: pick(e.customerId), sort: num(e.sort), createdAt, updatedAt: pick(e.updatedAt) });
      }
      out.sort((a,b) =>
        String(b.createdAt).localeCompare(String(a.createdAt)) ||
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) ||
        ((b.sort ?? 0) - (a.sort ?? 0))
      );
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: out };
      return;
    }

    if (method === "POST" && req.url.includes("/reorder")) {
      const b = req.body || {};
      const laneId = pick(b.laneId);
      const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
      for (let i = 0; i < ids.length; i++) await items.upsertEntity({ partitionKey: PARTITION, rowKey: ids[i], sort: i * 10, laneId }, "Merge");
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
        const now = new Date().toISOString();
        await items.upsertEntity({ partitionKey: PARTITION, rowKey, title, laneId, customerId, sort: max + 10, createdAt: now, updatedAt: now }, "Merge");
        await events.upsertEntity({ partitionKey: PARTITION, rowKey: randomUUID(), type: "created", workItemId: rowKey, laneId, at: now }, "Merge");
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
          try {
            const cust = customerId ? await customers.getEntity(PARTITION, customerId) : null;
            const customer = cust ? { name: pick(cust.name), email: pick(cust.email), phone: pick(cust.phone) } : null;
            await notify(context, laneId, { id: rid, title }, customer);
          } catch (e) {
            context.log(`notify error ${String(e)}`);
          }
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
