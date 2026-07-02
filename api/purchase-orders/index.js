const { TableClient } = require("../_shared/table-client");
const { randomUUID } = require("crypto");
const { resolveTenantId } = require("../_shared/tenant");
const { requirePrincipal } = require("../_shared/auth");

const PURCHASE_ORDER_TABLE = "purchaseorders";
const INVENTORY_TABLE = "inventoryitems";
const NEEDS_TABLE = "inventoryneeds";

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function normalizeOrderStatus(raw) {
  const value = asString(raw).toLowerCase();
  if (value === "ordered") return "ordered";
  if (value === "received") return "received";
  if (value === "cancelled") return "cancelled";
  return "draft";
}

function normalizeNeedStatus(raw) {
  const value = asString(raw).toLowerCase();
  if (value === "ordered") return "ordered";
  if (value === "po-draft") return "po-draft";
  if (value === "received") return "received";
  if (value === "cancelled") return "cancelled";
  return "needs-order";
}

function normalizeJobPartStatus(raw) {
  const status = normalizeNeedStatus(raw);
  if (status === "ordered" || status === "po-draft") return "ordered";
  if (status === "received") return "received";
  if (status === "cancelled") return "returned";
  return "quoted";
}

async function getTableClient(tableName) {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn, tableName);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

function normalizeLine(raw, index) {
  const source = raw && typeof raw === "object" ? raw : {};
  const qty = Math.max(1, Math.floor(asNumber(source.qty, 1)));
  const qtyReceived = Math.max(0, Math.min(qty, asNumber(source.qtyReceived, 0)));
  const partName = asString(source.partName || source.name || source.description);
  const sku = asString(source.sku || source.partNumber);
  const unitCost = Math.max(0, asNumber(source.unitCost, 0));
  if (!partName && !sku) return null;

  return {
    lineId: asString(source.lineId) || `line-${index + 1}`,
    needId: asString(source.needId),
    itemId: asString(source.itemId || source.relatedInventoryItemId),
    relatedInventoryItemId: asString(source.relatedInventoryItemId || source.itemId),
    jobId: asString(source.jobId),
    jobNumber: asString(source.jobNumber),
    partName,
    sku,
    vendorId: asString(source.vendorId),
    vendor: asString(source.vendor || source.vendorHint || source.supplier),
    qty,
    qtyNeeded: Math.max(1, Math.floor(asNumber(source.qtyNeeded, qty))),
    qtyOrdered: Math.max(0, Math.floor(asNumber(source.qtyOrdered, qty))),
    qtyReceived,
    unitCost,
    orderNumber: asString(source.orderNumber),
    trackingNumber: asString(source.trackingNumber),
    etaDate: asString(source.etaDate),
    vendorInvoiceNumber: asString(source.vendorInvoiceNumber),
    note: asString(source.note || source.notes),
    lineTotal: Number((qty * unitCost).toFixed(2)),
    status: qtyReceived >= qty ? "received" : (qtyReceived > 0 ? "partial" : "ordered")
  };
}

function parseLines(value) {
  const raw = asArray(value);
  const lines = [];
  for (let i = 0; i < raw.length; i++) {
    const line = normalizeLine(raw[i], i);
    if (!line) continue;
    lines.push(line);
  }
  return lines;
}

function parseLinesFromEntity(entity) {
  return parseLines(entity.linesJson);
}

function summarizeLines(lines) {
  const subtotal = Number(lines.reduce((sum, item) => sum + asNumber(item.lineTotal), 0).toFixed(2));
  return {
    lineCount: lines.length,
    subtotal
  };
}

function toPurchaseOrder(entity) {
  const lines = parseLinesFromEntity(entity);
  const summary = summarizeLines(lines);
  return {
    id: asString(entity.rowKey),
    supplier: asString(entity.supplier),
    vendorId: asString(entity.vendorId),
    status: normalizeOrderStatus(entity.status),
    currency: asString(entity.currency) || "USD",
    note: asString(entity.note),
    lines,
    lineCount: summary.lineCount,
    subtotal: summary.subtotal,
    createdAt: asString(entity.createdAt),
    updatedAt: asString(entity.updatedAt),
    submittedAt: asString(entity.submittedAt) || null,
    receivedAt: asString(entity.receivedAt) || null
  };
}

function needIdsFromLines(lines) {
  const set = new Set();
  for (const line of lines) {
    const id = asString(line.needId);
    if (!id) continue;
    set.add(id);
  }
  return Array.from(set);
}

async function fetchNeedsByIds(needsClient, tenantId, ids) {
  const out = [];
  for (const id of ids) {
    const needId = asString(id);
    if (!needId) continue;
    try {
      const entity = await needsClient.getEntity(tenantId, needId);
      out.push(entity);
    } catch (_) {}
  }
  return out;
}

function lineFromNeed(need, index) {
  const qtyNeeded = Math.max(1, Math.floor(asNumber(need.qtyNeeded, asNumber(need.qty, 1))));
  const qtyOrdered = Math.max(0, Math.floor(asNumber(need.qtyOrdered, 0)));
  const qtyReceived = Math.max(0, Math.floor(asNumber(need.qtyReceived, 0)));
  const qty = Math.max(1, qtyNeeded - Math.max(qtyOrdered, qtyReceived));
  const unitCost = Math.max(0, asNumber(need.estimatedCost || need.unitCost || need.cost, 0));
  return {
    lineId: `line-${index + 1}`,
    needId: asString(need.rowKey),
    itemId: asString(need.relatedInventoryItemId),
    relatedInventoryItemId: asString(need.relatedInventoryItemId),
    jobId: asString(need.jobId),
    jobNumber: asString(need.jobNumber),
    partName: asString(need.partName),
    sku: asString(need.sku),
    vendorId: asString(need.vendorId),
    vendor: asString(need.vendorHint),
    qty,
    qtyNeeded,
    qtyOrdered,
    qtyReceived: 0,
    unitCost,
    orderNumber: "",
    trackingNumber: "",
    etaDate: "",
    vendorInvoiceNumber: "",
    note: asString(need.note),
    lineTotal: Number((qty * unitCost).toFixed(2)),
    status: "ordered"
  };
}

async function updateNeedStates(needsClient, tenantId, ids, status, purchaseOrderId) {
  const now = new Date().toISOString();
  for (const id of ids) {
    const needId = asString(id);
    if (!needId) continue;
    await needsClient.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey: needId,
        status: normalizeNeedStatus(status),
        jobPartStatus: normalizeJobPartStatus(status),
        purchaseOrderId: asString(purchaseOrderId),
        updatedAt: now
      },
      "Merge"
    );
  }
}

async function updateNeedOrderedQuantities(needsClient, tenantId, lines, purchaseOrderId) {
  const now = new Date().toISOString();
  for (const line of lines) {
    const needId = asString(line.needId);
    if (!needId) continue;
    let existing = null;
    try {
      existing = await needsClient.getEntity(tenantId, needId);
    } catch (_) {}
    const currentOrdered = asNumber(existing && existing.qtyOrdered, 0);
    const currentReceived = asNumber(existing && existing.qtyReceived, 0);
    const qtyNeeded = Math.max(1, Math.floor(asNumber(existing && (existing.qtyNeeded || existing.qty), asNumber(line.qtyNeeded, line.qty))));
    const qtyOrdered = Math.max(currentOrdered, currentOrdered + Math.max(0, Math.floor(asNumber(line.qty, 0))));
    const isFullyReceived = currentReceived >= qtyNeeded;
    await needsClient.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey: needId,
        qtyNeeded,
        qtyOrdered,
        qtyReceived: currentReceived,
        status: isFullyReceived ? "received" : "ordered",
        jobPartStatus: isFullyReceived ? "received" : "ordered",
        purchaseOrderId: asString(purchaseOrderId),
        updatedAt: now
      },
      "Merge"
    );
  }
}

async function applyNeedReceipts(needsClient, tenantId, receiptLines, purchaseOrderId) {
  const now = new Date().toISOString();
  for (const line of receiptLines) {
    const needId = asString(line.needId);
    const delta = Math.max(0, asNumber(line.qty, 0));
    if (!needId || delta <= 0) continue;
    let existing = null;
    try {
      existing = await needsClient.getEntity(tenantId, needId);
    } catch (_) {}
    const qtyNeeded = Math.max(1, Math.floor(asNumber(existing && (existing.qtyNeeded || existing.qty), asNumber(line.qtyNeeded, line.qty))));
    const currentReceived = Math.max(0, asNumber(existing && existing.qtyReceived, 0));
    const currentOrdered = Math.max(0, asNumber(existing && existing.qtyOrdered, asNumber(line.qtyOrdered, 0)));
    const qtyReceived = Math.min(qtyNeeded, currentReceived + delta);
    const fullyReceived = qtyReceived >= Math.max(qtyNeeded, currentOrdered || qtyNeeded);
    await needsClient.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey: needId,
        qtyNeeded,
        qtyOrdered: Math.max(currentOrdered, asNumber(line.qtyOrdered, 0)),
        qtyReceived,
        status: fullyReceived ? "received" : "ordered",
        jobPartStatus: fullyReceived ? "received" : "ordered",
        purchaseOrderId: asString(purchaseOrderId),
        updatedAt: now
      },
      "Merge"
    );
  }
}

async function listInventoryItems(inventoryClient, tenantId) {
  const out = [];
  const iter = inventoryClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${escapedFilterValue(tenantId)}'` } });
  for await (const entity of iter) out.push(entity);
  return out;
}

function skuKey(value) {
  return asString(value).toLowerCase();
}

async function applyInventoryAdjustments(inventoryClient, tenantId, lines, mode) {
  const allItems = await listInventoryItems(inventoryClient, tenantId);
  const byId = new Map();
  const bySku = new Map();
  for (const item of allItems) {
    const id = asString(item.rowKey);
    if (id) byId.set(id, item);
    const key = skuKey(item.sku);
    if (key) bySku.set(key, item);
  }

  const now = new Date().toISOString();
  for (const line of lines) {
    const qty = Math.max(1, Math.floor(asNumber(line.qty, 1)));
    let item = null;
    const itemId = asString(line.itemId);
    const lineSku = asString(line.sku);
    if (itemId && byId.has(itemId)) {
      item = byId.get(itemId);
    } else if (lineSku && bySku.has(skuKey(lineSku))) {
      item = bySku.get(skuKey(lineSku));
    }

    if (!item) {
      const newId = randomUUID();
      const entity = {
        partitionKey: tenantId,
        rowKey: newId,
        name: asString(line.partName) || asString(line.sku) || "New Part",
        sku: lineSku,
        vendor: asString(line.vendor),
        category: "",
        onHand: mode === "receive" ? qty : 0,
        reorderAt: 0,
        onOrder: mode === "submit" ? qty : 0,
        unitCost: Math.max(0, asNumber(line.unitCost, 0)),
        lastUpdated: now,
        createdAt: now,
        updatedAt: now
      };
      await inventoryClient.upsertEntity(entity, "Merge");
      byId.set(newId, entity);
      if (lineSku) bySku.set(skuKey(lineSku), entity);
      continue;
    }

    const currentOnHand = asNumber(item.onHand, 0);
    const currentOnOrder = asNumber(item.onOrder, 0);
    let nextOnHand = currentOnHand;
    let nextOnOrder = currentOnOrder;
    if (mode === "submit") {
      nextOnOrder += qty;
    } else if (mode === "receive") {
      nextOnHand += qty;
      nextOnOrder = Math.max(0, nextOnOrder - qty);
    }

    item.onHand = nextOnHand;
    item.onOrder = nextOnOrder;
    item.lastUpdated = now;
    item.updatedAt = now;
    if (!item.unitCost || asNumber(item.unitCost, 0) <= 0) {
      item.unitCost = Math.max(0, asNumber(line.unitCost, 0));
    }

    await inventoryClient.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey: asString(item.rowKey),
        onHand: nextOnHand,
        onOrder: nextOnOrder,
        unitCost: asNumber(item.unitCost, 0),
        lastUpdated: now,
        updatedAt: now
      },
      "Merge"
    );
  }
}

function byUpdatedDesc(a, b) {
  const ta = Date.parse(asString(a.updatedAt || a.createdAt));
  const tb = Date.parse(asString(b.updatedAt || b.createdAt));
  if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
  if (Number.isFinite(tb)) return 1;
  if (Number.isFinite(ta)) return -1;
  return asString(a.id).localeCompare(asString(b.id));
}

function receiptRequestsFromBody(body, orderLines) {
  const raw = asArray(body.receipts || body.lines || body.receiveLines);
  const byLineId = new Map();
  for (const item of raw) {
    const source = item && typeof item === "object" ? item : {};
    const lineId = asString(source.lineId);
    if (!lineId) continue;
    byLineId.set(lineId, {
      qty: Math.max(0, asNumber(source.qtyReceived != null ? source.qtyReceived : source.qty, 0)),
      orderNumber: asString(source.orderNumber),
      trackingNumber: asString(source.trackingNumber),
      etaDate: asString(source.etaDate),
      vendorInvoiceNumber: asString(source.vendorInvoiceNumber),
      note: asString(source.note)
    });
  }

  const receiveAllRemaining = byLineId.size === 0;
  return orderLines.map(line => {
    const remaining = Math.max(0, asNumber(line.qty, 0) - asNumber(line.qtyReceived, 0));
    const requested = byLineId.get(asString(line.lineId));
    const delta = receiveAllRemaining ? remaining : Math.min(remaining, Math.max(0, asNumber(requested && requested.qty, 0)));
    return {
      ...line,
      receiveQty: delta,
      orderNumber: asString((requested && requested.orderNumber) || line.orderNumber),
      trackingNumber: asString((requested && requested.trackingNumber) || line.trackingNumber),
      etaDate: asString((requested && requested.etaDate) || line.etaDate),
      vendorInvoiceNumber: asString((requested && requested.vendorInvoiceNumber) || line.vendorInvoiceNumber),
      note: asString((requested && requested.note) || line.note)
    };
  });
}

function applyReceiptsToLines(lines, receipts) {
  const byLineId = new Map(receipts.map(item => [asString(item.lineId), item]));
  return lines.map(line => {
    const receipt = byLineId.get(asString(line.lineId));
    if (!receipt) return line;
    const qty = Math.max(1, asNumber(line.qty, 1));
    const qtyReceived = Math.min(qty, Math.max(0, asNumber(line.qtyReceived, 0) + Math.max(0, asNumber(receipt.receiveQty, 0))));
    return {
      ...line,
      qtyReceived,
      orderNumber: asString(receipt.orderNumber),
      trackingNumber: asString(receipt.trackingNumber),
      etaDate: asString(receipt.etaDate),
      vendorInvoiceNumber: asString(receipt.vendorInvoiceNumber),
      note: asString(receipt.note),
      status: qtyReceived >= qty ? "received" : (qtyReceived > 0 ? "partial" : "ordered")
    };
  });
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
    const purchaseClient = await getTableClient(PURCHASE_ORDER_TABLE);
    const inventoryClient = await getTableClient(INVENTORY_TABLE);
    const needsClient = await getTableClient(NEEDS_TABLE);

    if (method === "GET") {
      const id = queryParam(req, "id");
      const status = asString(queryParam(req, "status")).toLowerCase();
      if (id) {
        try {
          const entity = await purchaseClient.getEntity(tenantId, id);
          context.res = json(200, { ok: true, order: toPurchaseOrder(entity) });
        } catch (_) {
          context.res = json(404, { error: "Purchase order not found." });
        }
        return;
      }

      const out = [];
      const iter = purchaseClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${escapedFilterValue(tenantId)}'` } });
      for await (const entity of iter) {
        const order = toPurchaseOrder(entity);
        if (status && order.status !== status) continue;
        out.push(order);
      }
      out.sort(byUpdatedDesc);
      context.res = json(200, { ok: true, items: out });
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { error: "Method not allowed" });
      return;
    }

    const op = asString(body.op || body.operation || body.action).toLowerCase();

    if (op === "createdraft" || op === "create-draft") {
      const requestedNeedIds = asArray(body.needIds).map(asString).filter(Boolean);
      let lines = parseLines(body.lines);

      if (!lines.length && requestedNeedIds.length) {
        const needs = await fetchNeedsByIds(needsClient, tenantId, requestedNeedIds);
        lines = needs.map((need, index) => lineFromNeed(need, index));
      }
      if (!lines.length) {
        context.res = json(400, { error: "At least one line or needId is required." });
        return;
      }

      const supplier = asString(body.supplier || lines[0].vendor) || "Unassigned Supplier";
      const vendorId = asString(body.vendorId || lines[0].vendorId);
      const note = asString(body.note);
      const currency = asString(body.currency || "USD").toUpperCase();
      const id = randomUUID();
      const now = new Date().toISOString();
      const summary = summarizeLines(lines);
      await purchaseClient.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: id,
          supplier,
          vendorId,
          status: "draft",
          currency,
          note,
          linesJson: JSON.stringify(lines),
          subtotal: summary.subtotal,
          createdAt: now,
          updatedAt: now
        },
        "Merge"
      );

      const allNeedIds = Array.from(new Set([...requestedNeedIds, ...needIdsFromLines(lines)]));
      if (allNeedIds.length) {
        await updateNeedStates(needsClient, tenantId, allNeedIds, "po-draft", id);
      }

      const entity = await purchaseClient.getEntity(tenantId, id);
      context.res = json(200, { ok: true, order: toPurchaseOrder(entity) });
      return;
    }

    if (op === "updatedraft" || op === "update-draft") {
      const id = asString(body.id);
      if (!id) {
        context.res = json(400, { error: "id is required." });
        return;
      }

      let existing;
      try {
        existing = await purchaseClient.getEntity(tenantId, id);
      } catch (_) {
        context.res = json(404, { error: "Purchase order not found." });
        return;
      }

      const current = toPurchaseOrder(existing);
      if (current.status !== "draft") {
        context.res = json(400, { error: "Only draft purchase orders can be updated." });
        return;
      }

      const lines = body.lines != null ? parseLines(body.lines) : current.lines;
      if (!lines.length) {
        context.res = json(400, { error: "At least one line is required." });
        return;
      }

      const supplier = asString(body.supplier) || current.supplier;
      const vendorId = Object.prototype.hasOwnProperty.call(body, "vendorId") ? asString(body.vendorId) : asString(current.vendorId);
      const note = Object.prototype.hasOwnProperty.call(body, "note") ? asString(body.note) : current.note;
      const currency = asString(body.currency || current.currency || "USD").toUpperCase();
      const now = new Date().toISOString();
      const summary = summarizeLines(lines);
      await purchaseClient.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: id,
          supplier,
          vendorId,
          note,
          currency,
          linesJson: JSON.stringify(lines),
          subtotal: summary.subtotal,
          updatedAt: now
        },
        "Merge"
      );

      const oldNeedIds = new Set(needIdsFromLines(current.lines));
      const nextNeedIds = new Set(needIdsFromLines(lines));
      const removed = Array.from(oldNeedIds).filter(needId => !nextNeedIds.has(needId));
      const added = Array.from(nextNeedIds);
      if (removed.length) {
        await updateNeedStates(needsClient, tenantId, removed, "needs-order", "");
      }
      if (added.length) {
        await updateNeedStates(needsClient, tenantId, added, "po-draft", id);
      }

      const saved = await purchaseClient.getEntity(tenantId, id);
      context.res = json(200, { ok: true, order: toPurchaseOrder(saved) });
      return;
    }

    if (op === "submit" || op === "submit-order") {
      const id = asString(body.id);
      if (!id) {
        context.res = json(400, { error: "id is required." });
        return;
      }
      let existing;
      try {
        existing = await purchaseClient.getEntity(tenantId, id);
      } catch (_) {
        context.res = json(404, { error: "Purchase order not found." });
        return;
      }

      const order = toPurchaseOrder(existing);
      if (order.status !== "draft") {
        context.res = json(400, { error: "Only draft purchase orders can be submitted." });
        return;
      }

      const now = new Date().toISOString();
      await purchaseClient.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: id,
          status: "ordered",
          submittedAt: now,
          updatedAt: now
        },
        "Merge"
      );

      const needIds = needIdsFromLines(order.lines);
      if (needIds.length) {
        await updateNeedStates(needsClient, tenantId, needIds, "ordered", id);
        await updateNeedOrderedQuantities(needsClient, tenantId, order.lines, id);
      }
      await applyInventoryAdjustments(inventoryClient, tenantId, order.lines, "submit");

      const saved = await purchaseClient.getEntity(tenantId, id);
      context.res = json(200, { ok: true, order: toPurchaseOrder(saved) });
      return;
    }

    if (op === "receive" || op === "mark-received") {
      const id = asString(body.id);
      if (!id) {
        context.res = json(400, { error: "id is required." });
        return;
      }
      let existing;
      try {
        existing = await purchaseClient.getEntity(tenantId, id);
      } catch (_) {
        context.res = json(404, { error: "Purchase order not found." });
        return;
      }

      const order = toPurchaseOrder(existing);
      if (order.status !== "ordered") {
        context.res = json(400, { error: "Only ordered purchase orders can be received." });
        return;
      }

      const receipts = receiptRequestsFromBody(body, order.lines).filter(item => asNumber(item.receiveQty, 0) > 0);
      if (!receipts.length) {
        context.res = json(400, { error: "At least one line quantity is required to receive." });
        return;
      }

      const nextLines = applyReceiptsToLines(order.lines, receipts);
      const fullyReceived = nextLines.every(line => asNumber(line.qtyReceived, 0) >= asNumber(line.qty, 0));
      const now = new Date().toISOString();
      const summary = summarizeLines(nextLines);
      await purchaseClient.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: id,
          status: fullyReceived ? "received" : "ordered",
          linesJson: JSON.stringify(nextLines),
          subtotal: summary.subtotal,
          receivedAt: fullyReceived ? (asString(existing.receivedAt) || now) : asString(existing.receivedAt),
          updatedAt: now
        },
        "Merge"
      );

      const receiptLines = receipts.map(line => ({
        ...line,
        qty: asNumber(line.receiveQty, 0),
        qtyOrdered: asNumber(line.qty, 0)
      }));
      await applyNeedReceipts(needsClient, tenantId, receiptLines, id);
      await applyInventoryAdjustments(inventoryClient, tenantId, receiptLines, "receive");

      const saved = await purchaseClient.getEntity(tenantId, id);
      context.res = json(200, { ok: true, order: toPurchaseOrder(saved) });
      return;
    }

    if (op === "deletedraft" || op === "delete-draft") {
      const id = asString(body.id);
      if (!id) {
        context.res = json(400, { error: "id is required." });
        return;
      }
      let existing;
      try {
        existing = await purchaseClient.getEntity(tenantId, id);
      } catch (_) {
        context.res = json(404, { error: "Purchase order not found." });
        return;
      }
      const order = toPurchaseOrder(existing);
      if (order.status !== "draft") {
        context.res = json(400, { error: "Only draft purchase orders can be deleted." });
        return;
      }

      const needIds = needIdsFromLines(order.lines);
      if (needIds.length) {
        await updateNeedStates(needsClient, tenantId, needIds, "needs-order", "");
      }

      await purchaseClient.deleteEntity(tenantId, id);
      context.res = json(200, { ok: true, id });
      return;
    }

    context.res = json(400, { error: "Unknown operation." });
  } catch (err) {
    if (context.log && typeof context.log.error === "function") {
      context.log.error(err);
    }
    context.res = json(500, {
      error: "Server error",
      detail: String((err && err.message) || err)
    });
  }
};
