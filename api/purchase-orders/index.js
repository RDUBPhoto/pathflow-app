const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

const PARTITION = "main";
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
  const partName = asString(source.partName || source.name || source.description);
  const sku = asString(source.sku || source.partNumber);
  const unitCost = Math.max(0, asNumber(source.unitCost, 0));
  if (!partName && !sku) return null;

  return {
    lineId: asString(source.lineId) || `line-${index + 1}`,
    needId: asString(source.needId),
    itemId: asString(source.itemId),
    partName,
    sku,
    vendor: asString(source.vendor || source.vendorHint || source.supplier),
    qty,
    unitCost,
    note: asString(source.note || source.notes),
    lineTotal: Number((qty * unitCost).toFixed(2))
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

async function fetchNeedsByIds(needsClient, ids) {
  const out = [];
  for (const id of ids) {
    const needId = asString(id);
    if (!needId) continue;
    try {
      const entity = await needsClient.getEntity(PARTITION, needId);
      out.push(entity);
    } catch (_) {}
  }
  return out;
}

function lineFromNeed(need, index) {
  const qty = Math.max(1, Math.floor(asNumber(need.qty, 1)));
  const unitCost = Math.max(0, asNumber(need.estimatedCost || need.unitCost, 0));
  return {
    lineId: `line-${index + 1}`,
    needId: asString(need.rowKey),
    itemId: "",
    partName: asString(need.partName),
    sku: asString(need.sku),
    vendor: asString(need.vendorHint),
    qty,
    unitCost,
    note: asString(need.note),
    lineTotal: Number((qty * unitCost).toFixed(2))
  };
}

async function updateNeedStates(needsClient, ids, status, purchaseOrderId) {
  const now = new Date().toISOString();
  for (const id of ids) {
    const needId = asString(id);
    if (!needId) continue;
    await needsClient.upsertEntity(
      {
        partitionKey: PARTITION,
        rowKey: needId,
        status: normalizeNeedStatus(status),
        purchaseOrderId: asString(purchaseOrderId),
        updatedAt: now
      },
      "Merge"
    );
  }
}

async function listInventoryItems(inventoryClient) {
  const out = [];
  const iter = inventoryClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
  for await (const entity of iter) out.push(entity);
  return out;
}

function skuKey(value) {
  return asString(value).toLowerCase();
}

async function applyInventoryAdjustments(inventoryClient, lines, mode) {
  const allItems = await listInventoryItems(inventoryClient);
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
        partitionKey: PARTITION,
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
        partitionKey: PARTITION,
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

module.exports = async function (context, req) {
  const method = asString(req.method || "GET").toUpperCase();
  const body = asObject(req.body);
  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }

  try {
    const purchaseClient = await getTableClient(PURCHASE_ORDER_TABLE);
    const inventoryClient = await getTableClient(INVENTORY_TABLE);
    const needsClient = await getTableClient(NEEDS_TABLE);

    if (method === "GET") {
      const id = queryParam(req, "id");
      const status = asString(queryParam(req, "status")).toLowerCase();
      if (id) {
        try {
          const entity = await purchaseClient.getEntity(PARTITION, id);
          context.res = json(200, { ok: true, order: toPurchaseOrder(entity) });
        } catch (_) {
          context.res = json(404, { error: "Purchase order not found." });
        }
        return;
      }

      const out = [];
      const iter = purchaseClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
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
        const needs = await fetchNeedsByIds(needsClient, requestedNeedIds);
        lines = needs.map((need, index) => lineFromNeed(need, index));
      }
      if (!lines.length) {
        context.res = json(400, { error: "At least one line or needId is required." });
        return;
      }

      const supplier = asString(body.supplier || lines[0].vendor) || "Unassigned Supplier";
      const note = asString(body.note);
      const currency = asString(body.currency || "USD").toUpperCase();
      const id = randomUUID();
      const now = new Date().toISOString();
      const summary = summarizeLines(lines);
      await purchaseClient.upsertEntity(
        {
          partitionKey: PARTITION,
          rowKey: id,
          supplier,
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
        await updateNeedStates(needsClient, allNeedIds, "po-draft", id);
      }

      const entity = await purchaseClient.getEntity(PARTITION, id);
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
        existing = await purchaseClient.getEntity(PARTITION, id);
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
      const note = Object.prototype.hasOwnProperty.call(body, "note") ? asString(body.note) : current.note;
      const currency = asString(body.currency || current.currency || "USD").toUpperCase();
      const now = new Date().toISOString();
      const summary = summarizeLines(lines);
      await purchaseClient.upsertEntity(
        {
          partitionKey: PARTITION,
          rowKey: id,
          supplier,
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
        await updateNeedStates(needsClient, removed, "needs-order", "");
      }
      if (added.length) {
        await updateNeedStates(needsClient, added, "po-draft", id);
      }

      const saved = await purchaseClient.getEntity(PARTITION, id);
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
        existing = await purchaseClient.getEntity(PARTITION, id);
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
          partitionKey: PARTITION,
          rowKey: id,
          status: "ordered",
          submittedAt: now,
          updatedAt: now
        },
        "Merge"
      );

      const needIds = needIdsFromLines(order.lines);
      if (needIds.length) {
        await updateNeedStates(needsClient, needIds, "ordered", id);
      }
      await applyInventoryAdjustments(inventoryClient, order.lines, "submit");

      const saved = await purchaseClient.getEntity(PARTITION, id);
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
        existing = await purchaseClient.getEntity(PARTITION, id);
      } catch (_) {
        context.res = json(404, { error: "Purchase order not found." });
        return;
      }

      const order = toPurchaseOrder(existing);
      if (order.status !== "ordered") {
        context.res = json(400, { error: "Only ordered purchase orders can be received." });
        return;
      }

      const now = new Date().toISOString();
      await purchaseClient.upsertEntity(
        {
          partitionKey: PARTITION,
          rowKey: id,
          status: "received",
          receivedAt: now,
          updatedAt: now
        },
        "Merge"
      );

      const needIds = needIdsFromLines(order.lines);
      if (needIds.length) {
        await updateNeedStates(needsClient, needIds, "received", id);
      }
      await applyInventoryAdjustments(inventoryClient, order.lines, "receive");

      const saved = await purchaseClient.getEntity(PARTITION, id);
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
        existing = await purchaseClient.getEntity(PARTITION, id);
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
        await updateNeedStates(needsClient, needIds, "needs-order", "");
      }

      await purchaseClient.deleteEntity(PARTITION, id);
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
