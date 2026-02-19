const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

const TABLE = "schedule";
const PARTITION = "main";
const CUSTOMERS_TABLE = "customers";
const INVENTORY_NEEDS_TABLE = "inventoryneeds";

function pick(v, d = "") { return typeof v === "string" ? v : (v == null ? d : String(v)); }
function bool(v) { return v === true || v === "true" || v === 1 || v === "1"; }
function asString(v) { return v == null ? "" : String(v).trim(); }
function asNumber(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function normalizeNeedStatus(raw) {
  const value = asString(raw).toLowerCase();
  if (value === "ordered") return "ordered";
  if (value === "po-draft") return "po-draft";
  if (value === "received") return "received";
  if (value === "cancelled") return "cancelled";
  return "needs-order";
}

function parsePartRequestLine(line) {
  const raw = asString(line);
  if (!raw) return null;
  const match = raw.match(/^\s*(\d+)\s*[xX]\s+(.+?)(?:\s*\|\s*([^|]+))?(?:\s*\|\s*([^|]+))?(?:\s*\|\s*(.+))?$/);
  if (match) {
    return {
      partName: asString(match[2]),
      qty: Math.max(1, Math.floor(asNumber(match[1], 1))),
      vendorHint: asString(match[3]),
      sku: asString(match[4]),
      note: asString(match[5])
    };
  }
  return {
    partName: raw,
    qty: 1,
    vendorHint: "",
    sku: "",
    note: ""
  };
}

function normalizePartRequest(value) {
  if (!value) return null;
  if (typeof value === "string") {
    return parsePartRequestLine(value);
  }
  if (typeof value !== "object") return null;
  const partName = asString(value.partName || value.name || value.description);
  if (!partName) return null;
  return {
    partName,
    qty: Math.max(1, Math.floor(asNumber(value.qty, 1))),
    vendorHint: asString(value.vendorHint || value.vendor || value.supplier),
    sku: asString(value.sku || value.partNumber),
    note: asString(value.note || value.notes)
  };
}

function parsePartRequests(value) {
  let source = [];
  if (Array.isArray(value)) {
    source = value;
  } else if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) source = parsed;
      else source = raw.split(/\r?\n/);
    } catch {
      source = raw.split(/\r?\n/);
    }
  } else if (value && typeof value === "object") {
    source = [value];
  }

  const out = [];
  for (const item of source) {
    const normalized = normalizePartRequest(item);
    if (!normalized || !normalized.partName) continue;
    out.push(normalized);
    if (out.length >= 40) break;
  }
  return out;
}

function partSignature(item) {
  return `${asString(item.sku).toLowerCase()}|${asString(item.partName).toLowerCase()}|${asString(item.vendorHint).toLowerCase()}`;
}

function vehicleLabel(customer) {
  if (!customer) return "";
  return [customer.vehicleYear, customer.vehicleMake, customer.vehicleModel]
    .map(asString)
    .filter(Boolean)
    .join(" ");
}

async function getTableClient(conn, tableName) {
  const client = TableClient.fromConnectionString(conn, tableName);
  try { await client.createTable(); } catch (_) {}
  return client;
}

async function listNeedsForSchedule(needsClient, scheduleId) {
  const safeId = asString(scheduleId).replace(/'/g, "''");
  const out = [];
  const filter = `PartitionKey eq '${PARTITION}' and sourceType eq 'schedule' and sourceId eq '${safeId}'`;
  const iter = needsClient.listEntities({ queryOptions: { filter } });
  for await (const entity of iter) out.push(entity);
  return out;
}

async function getCustomerSummary(customersClient, customerId) {
  const id = asString(customerId);
  if (!id) return null;
  try {
    return await customersClient.getEntity(PARTITION, id);
  } catch {
    return null;
  }
}

async function syncScheduleNeeds(conn, scheduleRecord) {
  const scheduleId = asString(scheduleRecord.id);
  if (!scheduleId) return;
  const needsClient = await getTableClient(conn, INVENTORY_NEEDS_TABLE);
  const existing = await listNeedsForSchedule(needsClient, scheduleId);
  const removeAll = async () => {
    for (const need of existing) {
      try { await needsClient.deleteEntity(PARTITION, asString(need.rowKey)); } catch (_) {}
    }
  };

  if (bool(scheduleRecord.isBlocked) || !asString(scheduleRecord.customerId)) {
    await removeAll();
    return;
  }

  const partRequests = parsePartRequests(scheduleRecord.partRequests);
  if (!partRequests.length) {
    await removeAll();
    return;
  }

  const customersClient = await getTableClient(conn, CUSTOMERS_TABLE);
  const customer = await getCustomerSummary(customersClient, scheduleRecord.customerId);
  const customerName = asString(customer && (customer.name || `${customer.firstName || ""} ${customer.lastName || ""}`)) || "";
  const vehicle = vehicleLabel(customer);
  const now = new Date().toISOString();

  const existingBySig = new Map();
  for (const item of existing) {
    const sig = partSignature({
      partName: item.partName,
      sku: item.sku,
      vendorHint: item.vendorHint
    });
    const list = existingBySig.get(sig) || [];
    list.push(item);
    existingBySig.set(sig, list);
  }

  const retainedIds = new Set();
  for (const request of partRequests) {
    const sig = partSignature(request);
    const bucket = existingBySig.get(sig) || [];
    const reuse = bucket.length ? bucket.shift() : null;
    existingBySig.set(sig, bucket);
    const needId = asString(reuse && reuse.rowKey) || randomUUID();
    retainedIds.add(needId);
    const preservedStatus = normalizeNeedStatus(reuse && reuse.status);
    const status = preservedStatus === "needs-order" ? "needs-order" : preservedStatus;

    await needsClient.upsertEntity(
      {
        partitionKey: PARTITION,
        rowKey: needId,
        sourceType: "schedule",
        sourceId: scheduleId,
        scheduleStart: asString(scheduleRecord.start),
        scheduleEnd: asString(scheduleRecord.end),
        resource: asString(scheduleRecord.resource),
        customerId: asString(scheduleRecord.customerId),
        customerName,
        vehicle,
        partName: asString(request.partName),
        sku: asString(request.sku),
        qty: Math.max(1, Math.floor(asNumber(request.qty, 1))),
        vendorHint: asString(request.vendorHint),
        note: asString(request.note),
        status,
        purchaseOrderId: asString(reuse && reuse.purchaseOrderId),
        createdAt: asString(reuse && reuse.createdAt) || now,
        updatedAt: now
      },
      "Merge"
    );
  }

  for (const item of existing) {
    const needId = asString(item.rowKey);
    if (!needId || retainedIds.has(needId)) continue;
    try { await needsClient.deleteEntity(PARTITION, needId); } catch (_) {}
  }
}

async function clearScheduleNeeds(conn, scheduleId) {
  const needsClient = await getTableClient(conn, INVENTORY_NEEDS_TABLE);
  const existing = await listNeedsForSchedule(needsClient, scheduleId);
  for (const item of existing) {
    const needId = asString(item.rowKey);
    if (!needId) continue;
    try { await needsClient.deleteEntity(PARTITION, needId); } catch (_) {}
  }
}

module.exports = async function (context, req) {
  const method = (req.method || "GET").toUpperCase();
  const id = context.bindingData && context.bindingData.id ? String(context.bindingData.id) : "";

  if (method === "OPTIONS") { context.res = { status: 204 }; return; }

  try {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const client = await getTableClient(conn, TABLE);

    if (method === "GET") {
      const out = [];
      const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
      for await (const e of iter) {
        out.push({
          id: e.rowKey,
          start: pick(e.start),
          end: pick(e.end),
          resource: pick(e.resource),
          customerId: pick(e.customerId),
          isBlocked: bool(e.isBlocked),
          title: pick(e.title),
          notes: pick(e.notes),
          partRequests: parsePartRequests(e.partRequests),
          createdAt: pick(e.createdAt),
          updatedAt: pick(e.updatedAt)
        });
      }
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: out };
      return;
    }

    if (method === "POST") {
      const b = req.body || {};
      const rid = pick(b.id);
      const start = pick(b.start).trim();
      const end = pick(b.end).trim();
      const resource = pick(b.resource).trim();
      const customerId = pick(b.customerId).trim();
      const title = pick(b.title).trim();
      const notes = pick(b.notes).trim();
      const isBlocked = bool(b.isBlocked);
      const hasPartRequests = Object.prototype.hasOwnProperty.call(b, "partRequests")
        || Object.prototype.hasOwnProperty.call(b, "parts")
        || Object.prototype.hasOwnProperty.call(b, "partsRequested");
      const requestedPartRequests = hasPartRequests
        ? parsePartRequests(Object.prototype.hasOwnProperty.call(b, "partRequests") ? b.partRequests : (b.parts ?? b.partsRequested))
        : null;

      if (!rid && (!start || !end || !resource)) {
        context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "start, end, resource required" } };
        return;
      }

      if (!rid) {
        const rowKey = randomUUID();
        const now = new Date().toISOString();
        const entity = {
          partitionKey: PARTITION,
          rowKey,
          start,
          end,
          resource,
          customerId,
          isBlocked,
          title,
          notes,
          partRequests: JSON.stringify(requestedPartRequests || []),
          createdAt: now,
          updatedAt: now
        };
        await client.upsertEntity(entity, "Merge");
        await syncScheduleNeeds(conn, {
          id: rowKey,
          start,
          end,
          resource,
          customerId,
          isBlocked,
          partRequests: requestedPartRequests || []
        });
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rowKey } };
        return;
      } else {
        let current = null;
        try {
          current = await client.getEntity(PARTITION, rid);
        } catch (_) {}
        const effectivePartRequests = requestedPartRequests != null
          ? requestedPartRequests
          : parsePartRequests(current && current.partRequests);

        const patch = { partitionKey: PARTITION, rowKey: rid, updatedAt: new Date().toISOString() };
        if (start) patch.start = start;
        if (end) patch.end = end;
        if (resource) patch.resource = resource;
        if (customerId || Object.prototype.hasOwnProperty.call(b, "customerId")) patch.customerId = customerId;
        if (Object.prototype.hasOwnProperty.call(b, "isBlocked")) patch.isBlocked = isBlocked;
        if (Object.prototype.hasOwnProperty.call(b, "title")) patch.title = title;
        if (Object.prototype.hasOwnProperty.call(b, "notes")) patch.notes = notes;
        if (requestedPartRequests != null) patch.partRequests = JSON.stringify(requestedPartRequests);
        await client.upsertEntity(patch, "Merge");

        await syncScheduleNeeds(conn, {
          id: rid,
          start: start || pick(current && current.start),
          end: end || pick(current && current.end),
          resource: resource || pick(current && current.resource),
          customerId: (customerId || Object.prototype.hasOwnProperty.call(b, "customerId"))
            ? customerId
            : pick(current && current.customerId),
          isBlocked: Object.prototype.hasOwnProperty.call(b, "isBlocked")
            ? isBlocked
            : bool(current && current.isBlocked),
          partRequests: effectivePartRequests
        });
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rid } };
        return;
      }
    }

    if (method === "DELETE" && id) {
      await client.deleteEntity(PARTITION, id);
      await clearScheduleNeeds(conn, id);
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
      return;
    }

    context.res = { status: 405, headers: { "content-type": "application/json" }, body: { error: "Method not allowed" } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json" }, body: { error: "Server error", detail: String(err && err.message || err) } };
  }
};
