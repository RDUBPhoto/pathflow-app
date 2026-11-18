const { TableClient } = require("../_shared/table-client");
const { createHash } = require("crypto");
const { resolveTenantId } = require("../_shared/tenant");
const { requirePrincipal } = require("../_shared/auth");

const TABLE = "jobtasks";
const NEEDS_TABLE = "inventoryneeds";
const INVENTORY_TABLE = "inventoryitems";
const VENDORS_TABLE = "vendors";
const PURCHASE_ORDER_TABLE = "purchaseorders";
const DAY_MS = 24 * 60 * 60 * 1000;

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) {}
  }
  return {};
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return [];
}

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body
  };
}

function queryParam(req, key) {
  if (req.query && req.query[key] != null) return asString(req.query[key]);
  const rawUrl = asString(req.url);
  if (!rawUrl || rawUrl.indexOf("?") < 0) return "";
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    return asString(parsed.searchParams.get(key));
  } catch {
    return "";
  }
}

function escapedFilterValue(value) {
  return asString(value).replace(/'/g, "''");
}

async function getTableClient(tableName = TABLE) {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn, tableName);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

function normalizeStatus(value) {
  const normalized = asString(value).toLowerCase();
  if (normalized === "in_progress" || normalized === "in-progress") return "in_progress";
  if (normalized === "completed") return "completed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return "open";
}

function normalizePriority(value) {
  const normalized = asString(value).toLowerCase();
  if (normalized === "high") return "high";
  if (normalized === "low") return "low";
  return "normal";
}

function toTask(entity) {
  return {
    id: asString(entity.rowKey),
    taskType: asString(entity.taskType),
    jobId: asString(entity.jobId),
    jobNumber: asString(entity.jobNumber),
    relatedScheduleId: asString(entity.relatedScheduleId),
    relatedWorkItemId: asString(entity.relatedWorkItemId),
    relatedInvoiceId: asString(entity.relatedInvoiceId),
    customerName: asString(entity.customerName),
    vehicle: asString(entity.vehicle),
    title: asString(entity.title),
    description: asString(entity.description),
    assignedRole: asString(entity.assignedRole),
    ownerRole: asString(entity.ownerRole),
    ownerUser: asString(entity.ownerUser),
    dueDate: asString(entity.dueDate),
    priority: normalizePriority(entity.priority),
    status: normalizeStatus(entity.status),
    comments: asString(entity.comments),
    warning: asString(entity.warning),
    completedAt: asString(entity.completedAt),
    completedBy: asString(entity.completedBy),
    completedById: asString(entity.completedById),
    createdAt: asString(entity.createdAt),
    updatedAt: asString(entity.updatedAt)
  };
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeName(value) {
  return asString(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function toVendor(entity) {
  return {
    id: asString(entity.rowKey),
    name: asString(entity.name),
    normalizedName: asString(entity.normalizedName) || normalizeName(entity.name),
    contactName: asString(entity.contactName),
    email: asString(entity.email),
    phone: asString(entity.phone),
    website: asString(entity.website),
    accountNumber: asString(entity.accountNumber),
    notes: asString(entity.notes),
    isActive: entity.isActive !== false && entity.isActive !== "false"
  };
}

function toInventoryItem(entity) {
  return {
    id: asString(entity.rowKey),
    name: asString(entity.name),
    sku: asString(entity.sku),
    vendorId: asString(entity.vendorId),
    vendor: asString(entity.vendor),
    category: asString(entity.category),
    unitCost: asNumber(entity.unitCost, asNumber(entity.cost, 0)),
    cost: asNumber(entity.cost, 0),
    price: asNumber(entity.price, 0),
    onHand: asNumber(entity.onHand, 0),
    onOrder: asNumber(entity.onOrder, 0),
    reorderAt: asNumber(entity.reorderAt, 0)
  };
}

function normalizeOrderStatus(value) {
  const status = asString(value).toLowerCase();
  if (status === "ordered" || status === "submitted" || status === "sent") return "ordered";
  if (status === "received" || status === "closed") return "received";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return "draft";
}

function normalizePurchaseLine(raw) {
  const line = raw && typeof raw === "object" ? raw : {};
  return {
    lineId: asString(line.lineId),
    needId: asString(line.needId),
    relatedInventoryItemId: asString(line.relatedInventoryItemId || line.itemId),
    relatedInvoiceId: asString(line.relatedInvoiceId),
    relatedInvoiceLineItemId: asString(line.relatedInvoiceLineItemId),
    jobId: asString(line.jobId),
    jobNumber: asString(line.jobNumber),
    partName: asString(line.partName),
    sku: asString(line.sku),
    qty: asNumber(line.qty, 0),
    qtyOrdered: asNumber(line.qtyOrdered, asNumber(line.qty, 0)),
    qtyReceived: asNumber(line.qtyReceived, 0),
    unitCost: asNumber(line.unitCost, 0),
    orderNumber: asString(line.orderNumber),
    trackingNumber: asString(line.trackingNumber),
    carrier: asString(line.carrier),
    trackingStatus: asString(line.trackingStatus),
    trackingStatusUpdatedAt: asString(line.trackingStatusUpdatedAt),
    etaDate: asString(line.etaDate),
    estimatedDeliveryDate: asString(line.estimatedDeliveryDate),
    deliveredAt: asString(line.deliveredAt),
    vendorInvoiceNumber: asString(line.vendorInvoiceNumber),
    trackingLastError: asString(line.trackingLastError),
    status: asString(line.status)
  };
}

function purchaseOrderFromEntity(entity) {
  return {
    id: asString(entity.rowKey),
    status: normalizeOrderStatus(entity.status),
    supplier: asString(entity.supplier),
    createdAt: asString(entity.createdAt),
    updatedAt: asString(entity.updatedAt),
    submittedAt: asString(entity.submittedAt),
    receivedAt: asString(entity.receivedAt),
    lines: asArray(entity.linesJson).map(normalizePurchaseLine)
  };
}

function lineTrackingPayload(order, line) {
  if (!order || !line) return {};
  return {
    poLineId: asString(line.lineId),
    purchaseOrderId: asString(order.id),
    purchaseOrderStatus: asString(order.status),
    poLineStatus: asString(line.status),
    orderNumber: asString(line.orderNumber),
    trackingNumber: asString(line.trackingNumber),
    carrier: asString(line.carrier),
    trackingStatus: asString(line.trackingStatus),
    trackingStatusUpdatedAt: asString(line.trackingStatusUpdatedAt),
    etaDate: asString(line.etaDate || line.estimatedDeliveryDate),
    estimatedDeliveryDate: asString(line.estimatedDeliveryDate),
    deliveredAt: asString(line.deliveredAt),
    vendorInvoiceNumber: asString(line.vendorInvoiceNumber),
    trackingLastError: asString(line.trackingLastError)
  };
}

function lineMatchesNeed(line, need) {
  if (!line || !need) return false;
  if (asString(line.needId) && asString(line.needId) === asString(need.rowKey)) return true;
  if (asString(line.relatedInvoiceLineItemId) && asString(line.relatedInvoiceLineItemId) === asString(need.relatedInvoiceLineItemId)) return true;
  if (asString(line.relatedInventoryItemId) && asString(line.relatedInventoryItemId) === asString(need.relatedInventoryItemId)) return true;
  if (normalizeName(line.sku) && normalizeName(line.sku) === normalizeName(need.sku)) return true;
  return !!normalizeName(line.partName) && normalizeName(line.partName) === normalizeName(need.partName);
}

function toOrderPart(need, item, vendor, orderLine) {
  const linkedLine = orderLine && orderLine.line ? orderLine.line : null;
  const linkedOrder = orderLine && orderLine.order ? orderLine.order : null;
  const vendorName = asString(vendor && vendor.name) || asString(item && item.vendor) || asString(need.vendorHint);
  const needCost = asNumber(need.cost, 0);
  const itemUnitCost = asNumber(item && item.unitCost, 0);
  const itemCost = asNumber(item && item.cost, 0);
  const lineUnitCost = asNumber(linkedLine && linkedLine.unitCost, 0);
  const itemPrice = asNumber(item && item.price, 0);
  const unitCost = needCost > 0 ? needCost : (lineUnitCost > 0 ? lineUnitCost : (itemUnitCost > 0 ? itemUnitCost : itemCost));
  const customerPrice = asNumber(need.customerPrice, 0) > 0
    ? asNumber(need.customerPrice, 0)
    : itemPrice;
  return {
    id: asString(need.rowKey),
    inventoryNeedId: asString(need.rowKey),
    relatedInventoryItemId: asString(need.relatedInventoryItemId),
    relatedInvoiceId: asString(need.relatedInvoiceId),
    relatedInvoiceLineItemId: asString(need.relatedInvoiceLineItemId),
    purchaseOrderId: asString(need.purchaseOrderId) || asString(linkedOrder && linkedOrder.id),
    partName: asString(need.partName) || asString(item && item.name),
    description: asString(need.description) || asString(need.note),
    sku: asString(need.sku) || asString(item && item.sku),
    qtyNeeded: asNumber(need.qtyNeeded, asNumber(need.qty, 1)),
    qtyOrdered: asNumber(need.qtyOrdered, 0),
    qtyReceived: asNumber(need.qtyReceived, 0),
    qtyPulled: asNumber(need.qtyPulled, 0),
    status: asString(need.status) || "needs-order",
    jobPartStatus: asString(need.jobPartStatus),
    vendorId: asString(need.vendorId) || asString(item && item.vendorId) || asString(vendor && vendor.id),
    vendor: vendorName,
    vendorContactName: asString(vendor && vendor.contactName),
    vendorEmail: asString(vendor && vendor.email),
    vendorPhone: asString(vendor && vendor.phone),
    vendorWebsite: asString(vendor && vendor.website),
    vendorAccountNumber: asString(vendor && vendor.accountNumber),
    unitCost,
    customerPrice,
    shipping: asNumber(need.shipping, 0),
    ...lineTrackingPayload(linkedOrder, linkedLine),
    inventoryOnHand: asNumber(item && item.onHand, 0),
    inventoryOnOrder: asNumber(item && item.onOrder, 0),
    reorderAt: asNumber(item && item.reorderAt, 0),
    category: asString(item && item.category),
    note: asString(need.note),
    hasInventoryItem: !!asString(item && item.id)
  };
}

function byDueDate(a, b) {
  const ta = Date.parse(asString(a.dueDate));
  const tb = Date.parse(asString(b.dueDate));
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
  if (Number.isFinite(ta)) return -1;
  if (Number.isFinite(tb)) return 1;
  return asString(b.updatedAt || b.createdAt).localeCompare(asString(a.updatedAt || a.createdAt));
}

async function listTasks(client, tenantId) {
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${escapedFilterValue(tenantId)}'` } });
  for await (const entity of iter) out.push(toTask(entity));
  return out.sort(byDueDate);
}

async function listTenantEntities(client, tenantId, mapper) {
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${escapedFilterValue(tenantId)}'` } });
  for await (const entity of iter) out.push(mapper ? mapper(entity) : entity);
  return out;
}

async function enrichTasksWithOrderParts(tenantId, tasks) {
  const needsTasks = (Array.isArray(tasks) ? tasks : []).filter(task =>
    asString(task.relatedInvoiceId)
    || asString(task.jobNumber)
    || asString(task.jobId)
  );
  if (!needsTasks.length) return tasks;

  const [needsClient, itemsClient, vendorsClient, purchaseClient] = await Promise.all([
    getTableClient(NEEDS_TABLE),
    getTableClient(INVENTORY_TABLE),
    getTableClient(VENDORS_TABLE),
    getTableClient(PURCHASE_ORDER_TABLE)
  ]);
  const [needs, items, vendors, purchaseOrders] = await Promise.all([
    listTenantEntities(needsClient, tenantId),
    listTenantEntities(itemsClient, tenantId, toInventoryItem),
    listTenantEntities(vendorsClient, tenantId, toVendor),
    listTenantEntities(purchaseClient, tenantId, purchaseOrderFromEntity)
  ]);

  const itemsById = new Map(items.map(item => [asString(item.id), item]));
  const itemsBySku = new Map(
    items
      .map(item => [normalizeName(item.sku), item])
      .filter(([key]) => key)
  );
  const itemsByName = new Map(
    items
      .map(item => [normalizeName(item.name), item])
      .filter(([key]) => key)
  );
  const vendorsById = new Map(vendors.map(vendor => [asString(vendor.id), vendor]));
  const vendorsByName = new Map(vendors.map(vendor => [normalizeName(vendor.name), vendor]));
  const purchaseLinesByNeedId = new Map();
  const purchaseLinesByOrderId = new Map();
  const purchaseOrdersById = new Map();
  for (const order of purchaseOrders) {
    if (asString(order.status) === "cancelled") continue;
    const orderId = asString(order.id);
    if (orderId) purchaseOrdersById.set(orderId, order);
    for (const line of order.lines || []) {
      const row = { order, line };
      const needId = asString(line.needId);
      if (needId) purchaseLinesByNeedId.set(needId, row);
      if (orderId) {
        const existing = purchaseLinesByOrderId.get(orderId) || [];
        existing.push(row);
        purchaseLinesByOrderId.set(orderId, existing);
      }
    }
  }

  return tasks.map(task => {
    const relatedInvoiceId = asString(task.relatedInvoiceId);
    const jobNumber = asString(task.jobNumber);
    const jobId = asString(task.jobId);
    const relatedNeeds = needs.filter(need => {
      if (relatedInvoiceId && asString(need.relatedInvoiceId) === relatedInvoiceId) return true;
      if (jobNumber && asString(need.jobNumber) === jobNumber) return true;
      if (jobId && asString(need.jobId) === jobId) return true;
      return false;
    });
    if (!relatedNeeds.length) return task;
    const orderParts = relatedNeeds.map(need => {
      const item = itemsById.get(asString(need.relatedInventoryItemId))
        || itemsBySku.get(normalizeName(need.sku))
        || itemsByName.get(normalizeName(need.partName))
        || null;
      const vendorId = asString(need.vendorId) || asString(item && item.vendorId);
      const vendor = vendorsById.get(vendorId)
        || vendorsByName.get(normalizeName(need.vendorHint))
        || vendorsByName.get(normalizeName(item && item.vendor))
        || null;
      const rowsForOrder = asString(need.purchaseOrderId)
        ? (purchaseLinesByOrderId.get(asString(need.purchaseOrderId)) || [])
        : [];
      const orderLine = purchaseLinesByNeedId.get(asString(need.rowKey))
        || (rowsForOrder.length === 1 ? rowsForOrder[0] : null)
        || (rowsForOrder.length
          ? rowsForOrder.find(row => lineMatchesNeed(row && row.line, need))
          : null);
      const fallbackOrder = !orderLine && asString(need.purchaseOrderId)
        ? purchaseOrdersById.get(asString(need.purchaseOrderId))
        : null;
      const fallbackLine = fallbackOrder
        ? (fallbackOrder.lines || []).find(line => lineMatchesNeed(line, need))
          || ((fallbackOrder.lines || []).length === 1 ? fallbackOrder.lines[0] : null)
        : null;
      return toOrderPart(need, item, vendor, orderLine || (fallbackOrder && fallbackLine ? { order: fallbackOrder, line: fallbackLine } : null));
    });
    return { ...task, orderParts };
  });
}

function matchesQuery(task, query) {
  const jobId = asString(query.jobId);
  const jobNumber = asString(query.jobNumber);
  const scheduleId = asString(query.scheduleId);
  const workItemId = asString(query.workItemId);
  const status = asString(query.status).toLowerCase();
  if (jobId && task.jobId !== jobId) return false;
  if (jobNumber && task.jobNumber !== jobNumber) return false;
  if (scheduleId && task.relatedScheduleId !== scheduleId) return false;
  if (workItemId && task.relatedWorkItemId !== workItemId) return false;
  if (status && status !== "all" && task.status !== status) return false;
  return true;
}

function isoDateAtLocalStart(value, offsetDays) {
  const ts = Date.parse(asString(value));
  if (!Number.isFinite(ts)) return "";
  const date = new Date(ts + offsetDays * DAY_MS);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}

function startOfLocalDay(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function dueTodayDate() {
  const now = new Date();
  const today = new Date(now.getTime());
  today.setHours(9, 0, 0, 0);
  if (today.getTime() <= now.getTime()) {
    return new Date(now.getTime() + 5 * 60 * 1000);
  }
  return today;
}

function clampedReminderDueDate(installDate, offsetDays) {
  const installTs = Date.parse(asString(installDate));
  if (!Number.isFinite(installTs)) return "";
  const installDay = startOfLocalDay(installTs);
  const todayStart = startOfLocalDay(new Date());
  if (installDay.getTime() < todayStart.getTime()) return "";

  const target = new Date(installTs + offsetDays * DAY_MS);
  target.setHours(9, 0, 0, 0);
  if (target.getTime() < Date.now()) return dueTodayDate().toISOString();
  return target.toISOString();
}

function taskId(tenantId, jobKey, taskType, dueDate) {
  return createHash("sha1")
    .update([tenantId, jobKey, taskType, dueDate].join("|"))
    .digest("hex");
}

function jobKeyFrom(body) {
  return asString(body.jobId) || (asString(body.jobNumber) ? `job-number:${asString(body.jobNumber)}` : "") || asString(body.relatedScheduleId);
}

function partWarnings(parts, additionalParts, mode) {
  const warnings = [];
  const rows = asArray(parts);
  const additions = asArray(additionalParts).filter(part => {
    const approval = asString(part.approvalStatus).toLowerCase();
    const review = asString(part.invoiceReviewStatus).toLowerCase();
    return approval === "approved" || review === "needs_review";
  });

  if (mode === "readiness") {
    const notReceived = rows.filter(part => Number(part.qtyReceived || 0) < Number(part.qtyNeeded || 0));
    const backordered = rows.filter(part => asString(part.status).toLowerCase() === "backordered");
    if (notReceived.length) warnings.push(`${notReceived.length} required part(s) not fully received.`);
    if (backordered.length) warnings.push(`${backordered.length} required part(s) backordered.`);
    if (additions.length) warnings.push(`${additions.length} additional part(s) need approval/review consideration.`);
  } else {
    const notPulled = rows.filter(part => Number(part.qtyReceived || 0) > 0 && Number(part.qtyPulled || 0) < Number(part.qtyNeeded || 0));
    if (notPulled.length) warnings.push(`${notPulled.length} received part(s) not fully pulled.`);
    if (additions.length) warnings.push(`${additions.length} additional part(s) may need to be pulled or reviewed.`);
  }
  return warnings.join(" ");
}

function baseTaskFields(body) {
  return {
    jobId: asString(body.jobId),
    jobNumber: asString(body.jobNumber),
    relatedScheduleId: asString(body.relatedScheduleId),
    relatedWorkItemId: asString(body.relatedWorkItemId),
    customerName: asString(body.customerName),
    vehicle: asString(body.vehicle),
    assignedRole: asString(body.assignedRole) || "Inventory / Front Desk",
    ownerRole: asString(body.ownerRole) || "Inventory Manager",
    ownerUser: asString(body.ownerUser),
    priority: normalizePriority(body.priority || "normal")
  };
}

async function upsertGeneratedTask(client, tenantId, body, taskType, title, description, dueDate, warning) {
  const jobKey = jobKeyFrom(body);
  if (!jobKey || !dueDate) return null;
  const id = taskId(tenantId, jobKey, taskType, dueDate);
  const now = new Date().toISOString();
  let existing = null;
  try {
    existing = await client.getEntity(tenantId, id);
  } catch (_) {}

  const entity = {
    partitionKey: tenantId,
    rowKey: id,
    taskType,
    ...baseTaskFields(body),
    title,
    description,
    dueDate,
    warning: asString(warning),
    status: normalizeStatus(existing && existing.status),
    comments: asString(existing && existing.comments),
    completedAt: asString(existing && existing.completedAt),
    completedBy: asString(existing && existing.completedBy),
    completedById: asString(existing && existing.completedById),
    createdAt: asString(existing && existing.createdAt) || now,
    updatedAt: now
  };
  await client.upsertEntity(entity, "Merge");
  const saved = await client.getEntity(tenantId, id);
  return toTask(saved);
}

async function ensurePartsTasks(client, tenantId, body) {
  const installDate = asString(body.installDate);
  const parts = asArray(body.parts);
  if (!installDate || !parts.length) return [];
  const readinessDue = clampedReminderDueDate(installDate, -7);
  const pullDue = clampedReminderDueDate(installDate, -1);
  const additionalParts = asArray(body.additionalParts);
  const tasks = [];
  const readiness = await upsertGeneratedTask(
    client,
    tenantId,
    body,
    "parts-readiness",
    "Confirm all parts are ready for install",
    "Confirm all required parts are received or accounted for.",
    readinessDue,
    partWarnings(parts, additionalParts, "readiness")
  );
  if (readiness) tasks.push(readiness);
  const pull = await upsertGeneratedTask(
    client,
    tenantId,
    body,
    "parts-pull",
    "Pull parts for install",
    "Pull all received parts and confirm readiness for technician.",
    pullDue,
    partWarnings(parts, additionalParts, "pull")
  );
  if (pull) tasks.push(pull);
  return tasks;
}

function scheduledTaskGroupKey(need) {
  return asString(need.jobId)
    || (asString(need.jobNumber) ? `job-number:${asString(need.jobNumber)}` : "")
    || (asString(need.relatedScheduleId) ? `schedule:${asString(need.relatedScheduleId)}` : "");
}

function needAsTaskPart(need) {
  return {
    id: asString(need.rowKey),
    partName: asString(need.partName),
    sku: asString(need.sku),
    qtyNeeded: asNumber(need.qtyNeeded, asNumber(need.qty, 1)),
    qtyOrdered: asNumber(need.qtyOrdered, 0),
    qtyReceived: asNumber(need.qtyReceived, 0),
    qtyPulled: asNumber(need.qtyPulled, 0),
    status: asString(need.jobPartStatus) || asString(need.status)
  };
}

async function reconcileScheduledPartTasks(client, tenantId) {
  const needsClient = await getTableClient(NEEDS_TABLE);
  const needs = await listTenantEntities(needsClient, tenantId);
  const groups = new Map();
  for (const need of needs) {
    const installDate = asString(need.scheduleStart);
    const key = scheduledTaskGroupKey(need);
    const status = asString(need.status).toLowerCase();
    if (!installDate || !key || status === "cancelled" || status === "canceled") continue;
    const existing = groups.get(key) || {
      jobId: asString(need.jobId),
      jobNumber: asString(need.jobNumber),
      relatedScheduleId: asString(need.relatedScheduleId),
      relatedWorkItemId: asString(need.relatedWorkItemId),
      relatedInvoiceId: asString(need.relatedInvoiceId),
      customerName: asString(need.customerName),
      vehicle: asString(need.vehicle),
      installDate,
      parts: []
    };
    if (!existing.customerName) existing.customerName = asString(need.customerName);
    if (!existing.vehicle) existing.vehicle = asString(need.vehicle);
    if (!existing.relatedInvoiceId) existing.relatedInvoiceId = asString(need.relatedInvoiceId);
    if (!existing.relatedWorkItemId) existing.relatedWorkItemId = asString(need.relatedWorkItemId);
    existing.parts.push(needAsTaskPart(need));
    groups.set(key, existing);
  }

  const tasks = [];
  for (const group of groups.values()) {
    const ensured = await ensurePartsTasks(client, tenantId, group);
    tasks.push(...ensured);
  }
  return tasks;
}

function taskEntityFromBody(id, body, existing, principal) {
  const now = new Date().toISOString();
  const status = normalizeStatus(body.status || (existing && existing.status));
  const completedAt = status === "completed"
    ? asString(body.completedAt || (existing && existing.completedAt) || now)
    : asString(body.completedAt || (existing && existing.completedAt));
  return {
    partitionKey: asString(body.tenantId),
    rowKey: id,
    taskType: asString(body.taskType || (existing && existing.taskType) || "manual"),
    ...baseTaskFields({ ...(existing || {}), ...body }),
    title: asString(body.title || (existing && existing.title)),
    description: asString(body.description || (existing && existing.description)),
    dueDate: asString(body.dueDate || (existing && existing.dueDate)),
    status,
    comments: asString(body.comments || (existing && existing.comments)),
    warning: asString(body.warning || (existing && existing.warning)),
    completedAt,
    completedBy: status === "completed"
      ? asString(body.completedBy || (existing && existing.completedBy) || (principal && (principal.displayName || principal.email)))
      : asString(body.completedBy || (existing && existing.completedBy)),
    completedById: status === "completed"
      ? asString(body.completedById || (existing && existing.completedById) || (principal && (principal.userId || principal.email)))
      : asString(body.completedById || (existing && existing.completedById)),
    createdAt: asString(existing && existing.createdAt) || asString(body.createdAt) || now,
    updatedAt: now
  };
}

module.exports = async function (context, req) {
  const method = asString(req.method || "GET").toUpperCase();
  const body = asObject(req.body);
  const tenantId = resolveTenantId(req, body);
  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }
  const principal = await requirePrincipal(context, req);
  if (!principal) return;

  try {
    const client = await getTableClient();
    if (method === "GET") {
      try {
        await reconcileScheduledPartTasks(client, tenantId);
      } catch (err) {
        if (context.log && typeof context.log.warn === "function") {
          context.log.warn(`Could not reconcile scheduled part tasks: ${String((err && err.message) || err)}`);
        }
      }
      const id = queryParam(req, "id");
      if (id) {
        try {
          const entity = await client.getEntity(tenantId, id);
          const [task] = await enrichTasksWithOrderParts(tenantId, [toTask(entity)]);
          context.res = json(200, { ok: true, task });
        } catch (_) {
          context.res = json(404, { error: "Task not found." });
        }
        return;
      }
      const query = {
        jobId: queryParam(req, "jobId"),
        jobNumber: queryParam(req, "jobNumber"),
        scheduleId: queryParam(req, "scheduleId"),
        workItemId: queryParam(req, "workItemId"),
        status: queryParam(req, "status")
      };
      const tasks = await enrichTasksWithOrderParts(
        tenantId,
        (await listTasks(client, tenantId)).filter(task => matchesQuery(task, query))
      );
      context.res = json(200, { ok: true, tasks });
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { error: "Method not allowed" });
      return;
    }

    const op = asString(body.op || body.operation || body.action || "upsert").toLowerCase();
    if (op === "ensurepartstasks" || op === "ensure-parts-tasks") {
      const tasks = await ensurePartsTasks(client, tenantId, body);
      context.res = json(200, { ok: true, tasks });
      return;
    }

    if (op !== "create" && op !== "update" && op !== "upsert" && op !== "complete") {
      context.res = json(400, { error: "Unknown operation." });
      return;
    }

    const id = asString(body.id) || taskId(tenantId, jobKeyFrom(body) || "manual", asString(body.taskType || body.title), asString(body.dueDate || Date.now()));
    let existing = null;
    if (asString(body.id)) {
      try {
        existing = await client.getEntity(tenantId, id);
      } catch (_) {}
    }
    const nextBody = op === "complete" ? { ...body, status: "completed" } : body;
    const entity = taskEntityFromBody(id, { ...nextBody, tenantId }, existing, principal);
    if (!entity.title) {
      context.res = json(400, { error: "title is required." });
      return;
    }
    await client.upsertEntity(entity, "Merge");
    const saved = await client.getEntity(tenantId, id);
    context.res = json(200, { ok: true, task: toTask(saved) });
  } catch (err) {
    if (context.log && typeof context.log.error === "function") context.log.error(err);
    context.res = json(500, {
      error: "Server error",
      detail: String((err && err.message) || err)
    });
  }
};
