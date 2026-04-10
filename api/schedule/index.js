const { TableClient } = require("../_shared/table-client");
const { randomUUID } = require("crypto");
const { resolveTenantId } = require("../_shared/tenant");
const { requirePrincipal } = require("../_shared/auth");

const TABLE = "schedule";
const CUSTOMERS_TABLE = "customers";
const INVENTORY_NEEDS_TABLE = "inventoryneeds";
const WORKITEMS_TABLE = "workitems";
const LANES_TABLE = "lanes";

function pick(v, d = "") { return typeof v === "string" ? v : (v == null ? d : String(v)); }
function bool(v) { return v === true || v === "true" || v === 1 || v === "1"; }
function asString(v) { return v == null ? "" : String(v).trim(); }
function asNumber(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function toMillis(value) {
  const parsed = Date.parse(asString(value));
  return Number.isFinite(parsed) ? parsed : 0;
}
function safeDuration(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
function elapsedMs(fromValue, toValue) {
  const from = toMillis(fromValue);
  const to = toMillis(toValue);
  if (!from || !to || to <= from) return 0;
  return to - from;
}
function laneStageKey(lane) {
  const explicit = asString(lane && lane.stageKey).toLowerCase();
  if (explicit) return explicit;
  const name = asString(lane && lane.name).toLowerCase();
  if (!name) return "custom";
  if (/lead/.test(name)) return "lead";
  if (/quote/.test(name)) return "quote";
  if (/sched|appointment|calendar/.test(name)) return "scheduled";
  if (/progress|in[- ]?progress/.test(name)) return "inprogress";
  if (/complete|completed|done|ready|pickup/.test(name)) return "completed";
  if (/invoiced|invoice|paid/.test(name)) return "invoiced";
  return "custom";
}

function isActiveScheduleRecord(record, nowMs) {
  if (!record || bool(record.isBlocked)) return false;
  const customerId = asString(record.customerId);
  const resource = asString(record.resource);
  if (!customerId || !resource) return false;
  const startMs = toMillis(record.start);
  const endMs = effectiveScheduleEndMs(record);
  if (!startMs || !endMs || endMs <= startMs) return false;
  return startMs <= nowMs && nowMs < endMs;
}

function effectiveScheduleEndMs(record) {
  const plannedEndMs = toMillis(record && record.end);
  const actualEndMs = toMillis(record && record.actualEnd);
  const releasedMs = toMillis(record && record.bayReleasedAt);
  let effective = plannedEndMs;
  if (actualEndMs && (!effective || actualEndMs < effective)) effective = actualEndMs;
  if (releasedMs && (!effective || releasedMs < effective)) effective = releasedMs;
  return effective;
}

function compareSchedulePriority(a, b) {
  const aUpdated = Math.max(toMillis(a.updatedAt), toMillis(a.createdAt));
  const bUpdated = Math.max(toMillis(b.updatedAt), toMillis(b.createdAt));
  if (aUpdated !== bUpdated) return aUpdated - bUpdated;
  const aStart = toMillis(a.start);
  const bStart = toMillis(b.start);
  if (aStart !== bStart) return aStart - bStart;
  return asString(a.id).localeCompare(asString(b.id));
}

function activeBayOccupants(records, nowMs) {
  const byResource = new Map();
  for (const record of records || []) {
    if (!isActiveScheduleRecord(record, nowMs)) continue;
    const resourceKey = asString(record.resource).toLowerCase();
    if (!resourceKey) continue;
    const current = byResource.get(resourceKey);
    if (!current || compareSchedulePriority(current, record) < 0) {
      byResource.set(resourceKey, record);
    }
  }

  const customerIds = new Set();
  for (const occupant of byResource.values()) {
    const customerId = asString(occupant.customerId).toLowerCase();
    if (customerId) customerIds.add(customerId);
  }
  return customerIds;
}

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

async function listNeedsForSchedule(needsClient, tenantId, scheduleId) {
  const safeId = asString(scheduleId).replace(/'/g, "''");
  const out = [];
  const filter = `PartitionKey eq '${tenantId}' and sourceType eq 'schedule' and sourceId eq '${safeId}'`;
  const iter = needsClient.listEntities({ queryOptions: { filter } });
  for await (const entity of iter) out.push(entity);
  return out;
}

async function getCustomerSummary(customersClient, tenantId, customerId) {
  const id = asString(customerId);
  if (!id) return null;
  try {
    return await customersClient.getEntity(tenantId, id);
  } catch {
    return null;
  }
}

async function syncScheduleNeeds(conn, tenantId, scheduleRecord) {
  const scheduleId = asString(scheduleRecord.id);
  if (!scheduleId) return;
  const needsClient = await getTableClient(conn, INVENTORY_NEEDS_TABLE);
  const existing = await listNeedsForSchedule(needsClient, tenantId, scheduleId);
  const removeAll = async () => {
    for (const need of existing) {
      try { await needsClient.deleteEntity(tenantId, asString(need.rowKey)); } catch (_) {}
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
  const customer = await getCustomerSummary(customersClient, tenantId, scheduleRecord.customerId);
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
        partitionKey: tenantId,
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
    try { await needsClient.deleteEntity(tenantId, needId); } catch (_) {}
  }
}

async function clearScheduleNeeds(conn, tenantId, scheduleId) {
  const needsClient = await getTableClient(conn, INVENTORY_NEEDS_TABLE);
  const existing = await listNeedsForSchedule(needsClient, tenantId, scheduleId);
  for (const item of existing) {
    const needId = asString(item.rowKey);
    if (!needId) continue;
    try { await needsClient.deleteEntity(tenantId, needId); } catch (_) {}
  }
}

async function reconcileWorkTimers(conn, context, tenantId) {
  const schedulesClient = await getTableClient(conn, TABLE);
  const lanesClient = await getTableClient(conn, LANES_TABLE);
  const itemsClient = await getTableClient(conn, WORKITEMS_TABLE);

  const schedules = [];
  const scheduleIter = schedulesClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${tenantId}'` } });
  for await (const entity of scheduleIter) {
    schedules.push({
      id: entity.rowKey,
      start: pick(entity.start),
      end: pick(entity.end),
      actualEnd: pick(entity.actualEnd),
      bayReleasedAt: pick(entity.bayReleasedAt),
      resource: pick(entity.resource),
      customerId: pick(entity.customerId),
      isBlocked: bool(entity.isBlocked),
      createdAt: pick(entity.createdAt),
      updatedAt: pick(entity.updatedAt)
    });
  }

  const laneStageById = new Map();
  const laneIter = lanesClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${tenantId}'` } });
  for await (const lane of laneIter) {
    laneStageById.set(asString(lane.rowKey), laneStageKey(lane));
  }

  const nowIso = new Date().toISOString();
  const nowMs = toMillis(nowIso);
  const activeCustomers = activeBayOccupants(schedules, nowMs);

  let touched = 0;
  const itemsIter = itemsClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${tenantId}'` } });
  for await (const item of itemsIter) {
    const itemId = asString(item.rowKey);
    if (!itemId) continue;
    const customerId = asString(item.customerId).toLowerCase();
    const checkedInAt = asString(item.checkedInAt);
    const completedAt = asString(item.completedAt);
    if (!customerId || !checkedInAt || completedAt) continue;

    const stage = laneStageById.get(asString(item.laneId)) || "custom";
    if (stage === "completed") continue;

    const currentlyPaused = bool(item.isPaused) || !!asString(item.pausedAt);
    const shouldBeActive = activeCustomers.has(customerId);

    if (!shouldBeActive && !currentlyPaused) {
      const resumedAt = asString(item.lastWorkResumedAt) || checkedInAt;
      const workIncrement = elapsedMs(resumedAt, nowIso);
      await itemsClient.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: itemId,
          isPaused: true,
          pausedAt: nowIso,
          lastWorkResumedAt: "",
          workDurationMs: safeDuration(item.workDurationMs) + workIncrement,
          updatedAt: nowIso
        },
        "Merge"
      );
      touched += 1;
      continue;
    }

    if (shouldBeActive && currentlyPaused) {
      const pauseIncrement = elapsedMs(item.pausedAt, nowIso);
      await itemsClient.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: itemId,
          isPaused: false,
          pausedAt: "",
          lastWorkResumedAt: nowIso,
          pauseDurationMs: safeDuration(item.pauseDurationMs) + pauseIncrement,
          updatedAt: nowIso
        },
        "Merge"
      );
      touched += 1;
    }
  }

  context.log(`schedule/work-timers reconciled: ${touched} item(s) updated`);
}

module.exports = async function (context, req) {
  const method = (req.method || "GET").toUpperCase();
  const id = context.bindingData && context.bindingData.id ? String(context.bindingData.id) : "";
  const resolvedTenantId = resolveTenantId(req, req && req.body ? req.body : {});
  // Legacy compatibility: existing schedule rows were historically stored in "main".
  // Keep "primary-location" mapped to that partition until schedule data is fully migrated.
  const tenantId = resolvedTenantId === "primary-location" ? "main" : resolvedTenantId;

  if (method === "OPTIONS") { context.res = { status: 204 }; return; }
  const principal = await requirePrincipal(context, req);
  if (!principal) return;

  try {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const client = await getTableClient(conn, TABLE);

    if (method === "GET") {
      const out = [];
      const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${tenantId}'` } });
      for await (const e of iter) {
        out.push({
          id: e.rowKey,
          start: pick(e.start),
          end: pick(e.end),
          actualEnd: pick(e.actualEnd),
          bayReleasedAt: pick(e.bayReleasedAt),
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
      const actualEnd = Object.prototype.hasOwnProperty.call(b, "actualEnd") ? pick(b.actualEnd).trim() : null;
      const bayReleasedAt = Object.prototype.hasOwnProperty.call(b, "bayReleasedAt") ? pick(b.bayReleasedAt).trim() : null;
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
          partitionKey: tenantId,
          rowKey,
          start,
          end,
          resource,
          customerId,
          isBlocked,
          title,
          notes,
          actualEnd: "",
          bayReleasedAt: "",
          partRequests: JSON.stringify(requestedPartRequests || []),
          createdAt: now,
          updatedAt: now
        };
        await client.upsertEntity(entity, "Merge");
        await syncScheduleNeeds(conn, tenantId, {
          id: rowKey,
          start,
          end,
          resource,
          customerId,
          isBlocked,
          partRequests: requestedPartRequests || []
        });
        try { await reconcileWorkTimers(conn, context, tenantId); } catch (error) { context.log.warn(`work timer reconcile failed: ${String(error && error.message || error)}`); }
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rowKey } };
        return;
      } else {
        let current = null;
        try {
          current = await client.getEntity(tenantId, rid);
        } catch (_) {}
        const effectivePartRequests = requestedPartRequests != null
          ? requestedPartRequests
          : parsePartRequests(current && current.partRequests);

        const patch = { partitionKey: tenantId, rowKey: rid, updatedAt: new Date().toISOString() };
        if (start) patch.start = start;
        if (end) patch.end = end;
        if (resource) patch.resource = resource;
        if (customerId || Object.prototype.hasOwnProperty.call(b, "customerId")) patch.customerId = customerId;
        if (Object.prototype.hasOwnProperty.call(b, "isBlocked")) patch.isBlocked = isBlocked;
        if (Object.prototype.hasOwnProperty.call(b, "title")) patch.title = title;
        if (Object.prototype.hasOwnProperty.call(b, "notes")) patch.notes = notes;
        if (actualEnd !== null) patch.actualEnd = actualEnd;
        if (bayReleasedAt !== null) patch.bayReleasedAt = bayReleasedAt;
        if (requestedPartRequests != null) patch.partRequests = JSON.stringify(requestedPartRequests);
        await client.upsertEntity(patch, "Merge");

        await syncScheduleNeeds(conn, tenantId, {
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
        try { await reconcileWorkTimers(conn, context, tenantId); } catch (error) { context.log.warn(`work timer reconcile failed: ${String(error && error.message || error)}`); }
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rid } };
        return;
      }
    }

    if (method === "DELETE" && id) {
      await client.deleteEntity(tenantId, id);
      await clearScheduleNeeds(conn, tenantId, id);
      try { await reconcileWorkTimers(conn, context, tenantId); } catch (error) { context.log.warn(`work timer reconcile failed: ${String(error && error.message || error)}`); }
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
      return;
    }

    context.res = { status: 405, headers: { "content-type": "application/json" }, body: { error: "Method not allowed" } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json" }, body: { error: "Server error", detail: String(err && err.message || err) } };
  }
};
