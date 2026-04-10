const { TableClient } = require("../_shared/table-client");
const { randomUUID } = require("crypto");
const { resolveTenantId } = require("../_shared/tenant");
const { requirePrincipal } = require("../_shared/auth");

const INVENTORY_TABLE = "inventoryitems";
const NEEDS_TABLE = "inventoryneeds";
const CONNECTORS_TABLE = "inventoryconnectors";

const DEFAULT_CONNECTORS = [
  {
    id: "nexpart",
    provider: "WHI / Nexpart",
    segment: "Aftermarket",
    status: "planned",
    note: "Use WHI/Nexpart credentials to enable live catalog and ordering."
  },
  {
    id: "oreilly",
    provider: "O'Reilly Auto Parts",
    segment: "Aftermarket",
    status: "not-connected",
    note: "Partner/API access required."
  },
  {
    id: "autozone",
    provider: "AutoZone",
    segment: "Aftermarket",
    status: "not-connected",
    note: "Partner/API access required."
  },
  {
    id: "napa",
    provider: "NAPA",
    segment: "Aftermarket",
    status: "not-connected",
    note: "Often integrated through B2B parts networks."
  },
  {
    id: "ford",
    provider: "Ford",
    segment: "OEM",
    status: "partner-only",
    note: "Dealer credentials/integration required."
  },
  {
    id: "mopar",
    provider: "Mopar (Chrysler, Dodge, Jeep, Ram)",
    segment: "OEM",
    status: "partner-only",
    note: "Dealer credentials/integration required."
  },
  {
    id: "toyota",
    provider: "Toyota",
    segment: "OEM",
    status: "partner-only",
    note: "Dealer credentials/integration required."
  }
];
const MAX_TABLE_TRANSACTION_ACTIONS = 100;

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
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

function isPresent(value) {
  return asString(value) !== "";
}

function normalizeKey(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizedSku(value) {
  return asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function parseNumberInput(value, fallback = 0) {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const raw = asString(value);
  if (!raw) return fallback;
  const cleaned = raw.replace(/[$,%\s]/g, "").replace(/,/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : fallback;
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

async function getTableClient(tableName) {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn, tableName);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

function toInventoryItem(entity) {
  return {
    id: asString(entity.rowKey),
    name: asString(entity.name),
    sku: asString(entity.sku),
    vendor: asString(entity.vendor),
    category: asString(entity.category),
    unit: asString(entity.unit),
    accountCode: asString(entity.accountCode),
    purchaseAccountCode: asString(entity.purchaseAccountCode),
    salesTaxCode: asString(entity.salesTaxCode),
    purchaseTaxCode: asString(entity.purchaseTaxCode),
    discountPercent: asNumber(entity.discountPercent),
    cost: asNumber(entity.cost),
    price: asNumber(entity.price),
    onHand: asNumber(entity.onHand),
    reorderAt: asNumber(entity.reorderAt),
    onOrder: asNumber(entity.onOrder),
    unitCost: asNumber(entity.unitCost),
    lastUpdated: asString(entity.lastUpdated) || asString(entity.updatedAt),
    createdAt: asString(entity.createdAt),
    updatedAt: asString(entity.updatedAt)
  };
}

function normalizeNeedStatus(raw) {
  const value = asString(raw).toLowerCase();
  if (value === "ordered") return "ordered";
  if (value === "po-draft") return "po-draft";
  if (value === "received") return "received";
  if (value === "cancelled") return "cancelled";
  return "needs-order";
}

function toNeed(entity) {
  return {
    id: asString(entity.rowKey),
    sourceType: asString(entity.sourceType) || "schedule",
    sourceId: asString(entity.sourceId),
    scheduleStart: asString(entity.scheduleStart),
    scheduleEnd: asString(entity.scheduleEnd),
    resource: asString(entity.resource),
    customerId: asString(entity.customerId) || null,
    customerName: asString(entity.customerName) || null,
    vehicle: asString(entity.vehicle),
    partName: asString(entity.partName),
    sku: asString(entity.sku),
    qty: asNumber(entity.qty, 1),
    vendorHint: asString(entity.vendorHint),
    note: asString(entity.note),
    status: normalizeNeedStatus(entity.status),
    purchaseOrderId: asString(entity.purchaseOrderId) || null,
    createdAt: asString(entity.createdAt),
    updatedAt: asString(entity.updatedAt)
  };
}

function toConnector(entity) {
  const status = asString(entity.status).toLowerCase();
  return {
    id: asString(entity.rowKey),
    provider: asString(entity.provider),
    segment: asString(entity.segment),
    status: status || "not-connected",
    note: asString(entity.note),
    enabled: asBool(entity.enabled),
    configured: asBool(entity.configured),
    lastCheckedAt: asString(entity.lastCheckedAt) || null,
    lastError: asString(entity.lastError) || null,
    updatedAt: asString(entity.updatedAt) || null
  };
}

function parseProviderItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.products)) return payload.products;
  if (Array.isArray(payload.data)) return payload.data;
  if (payload.data && Array.isArray(payload.data.items)) return payload.data.items;
  return [];
}

function normalizeNexpartSearchResults(payload) {
  const rawItems = parseProviderItems(payload);
  return rawItems
    .slice(0, 40)
    .map((item, index) => {
      const obj = item && typeof item === "object" ? item : {};
      const partNumber = asString(
        obj.partNumber || obj.part_no || obj.partNo || obj.sku || obj.part || obj.mfrPartNumber
      );
      const description = asString(obj.description || obj.name || obj.title || obj.partDescription);
      const brand = asString(obj.brand || obj.manufacturer || obj.mfr || obj.make);
      const supplier = asString(obj.supplier || obj.vendor || obj.store || obj.warehouse);
      const availability = asString(
        obj.availability || obj.qtyAvailable || obj.quantityAvailable || obj.stock || obj.quantity
      );
      const price = asNumber(
        obj.price || obj.unitPrice || obj.listPrice || obj.salePrice || obj.cost,
        NaN
      );

      return {
        id: asString(obj.id || obj.key || obj.itemId) || `nexpart-${index}`,
        partNumber,
        description,
        brand,
        supplier,
        availability: availability || null,
        price: Number.isFinite(price) ? price : null,
        raw: obj
      };
    })
    .filter(item => item.partNumber || item.description);
}

function getNexpartConfig() {
  const baseUrl = asString(process.env.NEXPART_API_BASE_URL || process.env.WHI_API_BASE_URL);
  const apiKey = asString(process.env.NEXPART_API_KEY || process.env.WHI_API_KEY);
  const bearerToken = asString(process.env.NEXPART_BEARER_TOKEN || process.env.WHI_BEARER_TOKEN);
  const account = asString(process.env.NEXPART_ACCOUNT || process.env.WHI_ACCOUNT);
  const searchPath = asString(process.env.NEXPART_SEARCH_PATH) || "/search";
  const pingPath = asString(process.env.NEXPART_PING_PATH) || searchPath;
  const enabledRaw = asString(process.env.NEXPART_ENABLED).toLowerCase();
  const enabled = enabledRaw ? enabledRaw === "true" || enabledRaw === "1" : !!baseUrl;
  const configured = !!baseUrl && (!!apiKey || !!bearerToken);
  return {
    provider: "nexpart",
    enabled,
    configured,
    baseUrl,
    searchPath,
    pingPath,
    account,
    hasApiKey: !!apiKey,
    hasBearerToken: !!bearerToken,
    readyForLive: enabled && configured,
    apiKey,
    bearerToken
  };
}

async function callNexpart(config, params) {
  if (!config.enabled) {
    throw new Error("Nexpart connector is disabled. Set NEXPART_ENABLED=true.");
  }
  if (!config.readyForLive) {
    throw new Error("Nexpart connector is not configured. Set NEXPART_API_BASE_URL and auth credentials.");
  }

  const path = asString(params.path || config.searchPath);
  const query = new URLSearchParams();
  if (config.account) query.set("account", config.account);
  for (const [key, value] of Object.entries(params.query || {})) {
    const clean = asString(value);
    if (!clean) continue;
    query.set(key, clean);
  }
  const url = `${config.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}${query.toString() ? `?${query.toString()}` : ""}`;

  const headers = {
    Accept: "application/json"
  };
  if (config.apiKey) {
    headers["x-api-key"] = config.apiKey;
    headers["x-user-key"] = config.apiKey;
  }
  if (config.bearerToken) {
    headers.Authorization = `Bearer ${config.bearerToken}`;
  }

  const response = await fetch(url, {
    method: params.method || "GET",
    headers
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (_) {
    payload = { raw: text };
  }
  if (!response.ok) {
    const detail = asString(payload.error || payload.message || payload.detail || text || response.statusText);
    throw new Error(`Nexpart request failed (${response.status}): ${detail || "Unknown provider response."}`);
  }
  return {
    status: response.status,
    payload
  };
}

function byUpdatedDesc(a, b) {
  const ta = Date.parse(asString(a.updatedAt || a.lastUpdated || a.createdAt));
  const tb = Date.parse(asString(b.updatedAt || b.lastUpdated || b.createdAt));
  if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
  if (Number.isFinite(tb)) return 1;
  if (Number.isFinite(ta)) return -1;
  return asString(a.id).localeCompare(asString(b.id));
}

function byScheduleStartAsc(a, b) {
  const ta = Date.parse(asString(a.scheduleStart || a.createdAt));
  const tb = Date.parse(asString(b.scheduleStart || b.createdAt));
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
  if (Number.isFinite(tb)) return 1;
  if (Number.isFinite(ta)) return -1;
  return asString(a.id).localeCompare(asString(b.id));
}

function buildSummary(items, needs) {
  const lowStockCount = items.filter(item => item.onHand <= item.reorderAt).length;
  const totalOnHand = items.reduce((sum, item) => sum + asNumber(item.onHand), 0);
  const totalOnOrder = items.reduce((sum, item) => sum + asNumber(item.onOrder), 0);
  const totalInventoryValue = items.reduce((sum, item) => sum + (asNumber(item.onHand) * asNumber(item.unitCost)), 0);
  const pendingNeeds = needs.filter(item => item.status === "needs-order" || item.status === "po-draft").length;
  return {
    lowStockCount,
    totalOnHand,
    totalOnOrder,
    totalInventoryValue,
    pendingNeeds
  };
}

function buildInventoryLookup(items) {
  const bySku = new Map();
  const byNameVendor = new Map();
  const byName = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    addInventoryLookupItem({ bySku, byNameVendor, byName }, item);
  }
  return { bySku, byNameVendor, byName };
}

function addInventoryLookupItem(lookup, item) {
  if (!lookup || !item) return;
  const sku = normalizedSku(item.sku);
  if (sku) lookup.bySku.set(sku, item);
  const name = normalizeKey(item.name);
  if (!name) return;
  if (!lookup.byName.has(name)) lookup.byName.set(name, item);
  const vendor = normalizeKey(item.vendor);
  if (vendor) lookup.byNameVendor.set(`${name}|${vendor}`, item);
}

function findExistingInventoryItem(lookup, row) {
  const sku = normalizedSku(row && row.sku);
  if (sku && lookup && lookup.bySku.has(sku)) {
    return lookup.bySku.get(sku);
  }

  const name = normalizeKey(row && row.name);
  if (!name || !lookup) return null;
  const vendor = normalizeKey(row && row.vendor);
  if (vendor) {
    const byNameVendor = lookup.byNameVendor.get(`${name}|${vendor}`);
    if (byNameVendor) return byNameVendor;
  }
  return lookup.byName.get(name) || null;
}

async function executeInventoryUpserts(client, operations, errors) {
  if (!Array.isArray(operations) || !operations.length) {
    return { created: 0, updated: 0 };
  }

  let created = 0;
  let updated = 0;

  for (let i = 0; i < operations.length; i += MAX_TABLE_TRANSACTION_ACTIONS) {
    const chunk = operations.slice(i, i + MAX_TABLE_TRANSACTION_ACTIONS);
    const actions = chunk.map(op => ["upsert", op.entity, "Merge"]);
    try {
      await client.submitTransaction(actions);
      for (const op of chunk) {
        if (op.mode === "create") {
          created += 1;
        } else {
          updated += 1;
        }
      }
    } catch (_) {
      for (const op of chunk) {
        try {
          await client.upsertEntity(op.entity, "Merge");
          if (op.mode === "create") {
            created += 1;
          } else {
            updated += 1;
          }
        } catch (error) {
          errors.push({
            index: op.index,
            error: asString(error && error.message) || "Import row failed."
          });
        }
      }
    }
  }

  return { created, updated };
}

async function ensureDefaultConnectors(client, tenantId) {
  const existing = [];
  const existingById = new Map();
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${escapedFilterValue(tenantId)}'` } });
  for await (const entity of iter) {
    const connector = toConnector(entity);
    if (!connector.id) continue;
    existing.push(connector);
    existingById.set(connector.id, connector);
  }

  const now = new Date().toISOString();
  for (const seed of DEFAULT_CONNECTORS) {
    if (existingById.has(seed.id)) continue;
    await client.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey: seed.id,
        provider: seed.provider,
        segment: seed.segment,
        status: seed.status,
        note: seed.note,
        enabled: false,
        configured: false,
        updatedAt: now
      },
      "Merge"
    );
    existingById.set(seed.id, {
      ...seed,
      enabled: false,
      configured: false,
      lastCheckedAt: null,
      lastError: null,
      updatedAt: now
    });
  }

  return Array.from(existingById.values()).sort((a, b) => asString(a.provider).localeCompare(asString(b.provider)));
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
    const inventoryClient = await getTableClient(INVENTORY_TABLE);
    const needsClient = await getTableClient(NEEDS_TABLE);
    const connectorsClient = await getTableClient(CONNECTORS_TABLE);
    const nexpart = getNexpartConfig();

    if (method === "GET") {
      const scope = queryParam(req, "scope").toLowerCase();
      const statusFilter = queryParam(req, "status").toLowerCase();

      const listItems = async () => {
        const out = [];
        const iter = inventoryClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${escapedFilterValue(tenantId)}'` } });
        for await (const entity of iter) out.push(toInventoryItem(entity));
        out.sort((a, b) => asString(a.name).localeCompare(asString(b.name)));
        return out;
      };

      const listNeeds = async () => {
        const out = [];
        const filter = statusFilter
          ? `PartitionKey eq '${escapedFilterValue(tenantId)}' and status eq '${escapedFilterValue(statusFilter)}'`
          : `PartitionKey eq '${escapedFilterValue(tenantId)}'`;
        const iter = needsClient.listEntities({ queryOptions: { filter } });
        for await (const entity of iter) out.push(toNeed(entity));
        out.sort(byScheduleStartAsc);
        return out;
      };

      if (scope === "items") {
        context.res = json(200, { ok: true, scope, items: await listItems() });
        return;
      }
      if (scope === "needs") {
        context.res = json(200, { ok: true, scope, needs: await listNeeds() });
        return;
      }
      if (scope === "connectors") {
        const connectors = await ensureDefaultConnectors(connectorsClient, tenantId);
        context.res = json(200, {
          ok: true,
          scope,
          nexpart: {
            ...nexpart,
            apiKey: undefined,
            bearerToken: undefined
          },
          connectors
        });
        return;
      }
      if (scope === "nexpart") {
        context.res = json(200, {
          ok: true,
          scope,
          nexpart: {
            ...nexpart,
            apiKey: undefined,
            bearerToken: undefined
          }
        });
        return;
      }

      const items = await listItems();
      const needs = await listNeeds();
      const connectors = await ensureDefaultConnectors(connectorsClient, tenantId);
      context.res = json(200, {
        ok: true,
        items,
        needs,
        connectors,
        summary: buildSummary(items, needs),
        nexpart: {
          ...nexpart,
          apiKey: undefined,
          bearerToken: undefined
        }
      });
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { error: "Method not allowed" });
      return;
    }

    const op = asString(body.op || body.operation || body.action).toLowerCase();

    if (op === "upsertitem" || op === "upsert-item") {
      const id = asString(body.id) || randomUUID();
      const now = new Date().toISOString();
      const name = asString(body.name || body.description);
      const sku = asString(body.sku || body.partLaborCode || body.itemCode);
      if (!name && !sku) {
        context.res = json(400, { error: "name or sku is required." });
        return;
      }

      const rawOnHand = body.onHand != null ? body.onHand : body.freeStock;
      const rawUnitCost = body.unitCost != null
        ? body.unitCost
        : (body.price != null ? body.price : body.cost);

      const entity = {
        partitionKey: tenantId,
        rowKey: id,
        name,
        sku,
        vendor: asString(body.vendor || body.mainSupplier),
        category: asString(body.category),
        unit: asString(body.unit),
        accountCode: asString(body.accountCode || body.salesAccountCode),
        purchaseAccountCode: asString(body.purchaseAccountCode || body.purchasesAccountCode),
        salesTaxCode: asString(body.salesTaxCode),
        purchaseTaxCode: asString(body.purchaseTaxCode || body.purchasesTaxCode),
        discountPercent: asNumber(body.discountPercent),
        cost: asNumber(body.cost),
        price: asNumber(body.price),
        onHand: asNumber(rawOnHand),
        reorderAt: asNumber(body.reorderAt),
        onOrder: asNumber(body.onOrder),
        unitCost: asNumber(rawUnitCost),
        lastUpdated: now,
        updatedAt: now
      };
      if (!asString(body.createdAt)) {
        entity.createdAt = now;
      } else {
        entity.createdAt = asString(body.createdAt);
      }

      await inventoryClient.upsertEntity(entity, "Merge");
      context.res = json(200, { ok: true, item: toInventoryItem({ ...entity, rowKey: id }) });
      return;
    }

    if (op === "import" || op === "importitems" || op === "import-items") {
      const rows = asArray(body.rows);
      if (!rows.length) {
        context.res = json(400, { error: "rows is required." });
        return;
      }

      const existingItems = [];
      const iter = inventoryClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${escapedFilterValue(tenantId)}'` } });
      for await (const entity of iter) {
        existingItems.push(toInventoryItem(entity));
      }
      const lookup = buildInventoryLookup(existingItems);

      let skipped = 0;
      const errors = [];
      const operationsByRowKey = new Map();

      for (let i = 0; i < rows.length; i += 1) {
        const source = asObject(rows[i]);
        try {
          const name = asString(
            source.description || source.name || source.partName || source.detailedDescription
          );
          const sku = asString(
            source.partLaborCode ||
            source.sku ||
            source.partNumber ||
            source.partNo ||
            source.itemCode ||
            source.baseVariantCode ||
            source.rawVariantCode ||
            source.variantCode
          );
          const vendor = asString(
            source.mainSupplier ||
            source.vendor ||
            source.supplier ||
            source.manufacturer ||
            source.metaProduct
          );
          const category = asString(source.category || source.categoryList || source.department || source.type);
          const unit = asString(source.unit);
          const accountCode = asString(source.accountCode || source.salesAccountCode);
          const purchaseAccountCode = asString(source.purchaseAccountCode || source.purchasesAccountCode);
          const salesTaxCode = asString(source.salesTaxCode);
          const purchaseTaxCode = asString(source.purchaseTaxCode || source.purchasesTaxCode);

          const rawOnHand = source.freeStock != null
            ? source.freeStock
            : (source.onHand != null ? source.onHand : source.current);
          const rawReorderAt = source.reorderAt != null
            ? source.reorderAt
            : (source.minReorder != null ? source.minReorder : (source.reorderLevel != null ? source.reorderLevel : source.reorderPoint));
          const rawOnOrder = source.onOrder;
          const rawDiscountPercent = source.discountPercent != null ? source.discountPercent : source.discount;
          const rawCost = source.cost != null
            ? source.cost
            : (source.averageCost != null ? source.averageCost : source.costPrice);
          const rawPrice = source.price != null
            ? source.price
            : (source.unitPrice != null ? source.unitPrice : source.purchasePrice);
          const rawUnitCost = source.unitCost != null
            ? source.unitCost
            : (rawPrice != null ? rawPrice : rawCost);

          const hasOnHand = isPresent(rawOnHand);
          const hasReorderAt = isPresent(rawReorderAt);
          const hasOnOrder = isPresent(rawOnOrder);
          const hasDiscountPercent = isPresent(rawDiscountPercent);
          const hasCost = isPresent(rawCost);
          const hasPrice = isPresent(rawPrice);
          const hasUnitCost = isPresent(rawUnitCost);
          const onHand = parseNumberInput(rawOnHand, 0);
          const reorderAt = parseNumberInput(rawReorderAt, 0);
          const onOrder = parseNumberInput(rawOnOrder, 0);
          const discountPercent = parseNumberInput(rawDiscountPercent, 0);
          const cost = parseNumberInput(rawCost, 0);
          const price = parseNumberInput(rawPrice, 0);
          const unitCost = parseNumberInput(rawUnitCost, 0);

          if (!name && !sku) {
            skipped += 1;
            continue;
          }

          const now = new Date().toISOString();
          const existing = findExistingInventoryItem(lookup, {
            name,
            sku,
            vendor
          });

          if (!existing) {
            const rowKey = randomUUID();
            const entity = {
              partitionKey: tenantId,
              rowKey,
              name: name || sku,
              sku,
              vendor,
              category,
              unit,
              accountCode,
              purchaseAccountCode,
              salesTaxCode,
              purchaseTaxCode,
              discountPercent,
              cost,
              price,
              onHand,
              reorderAt,
              onOrder,
              unitCost,
              lastUpdated: now,
              createdAt: now,
              updatedAt: now
            };
            const createdItem = toInventoryItem(entity);
            existingItems.push(createdItem);
            addInventoryLookupItem(lookup, createdItem);
            operationsByRowKey.set(rowKey, {
              index: i,
              mode: "create",
              entity
            });
            continue;
          }

          const patch = {
            partitionKey: tenantId,
            rowKey: existing.id,
            updatedAt: now,
            lastUpdated: now
          };

          if (name && !asString(existing.name)) patch.name = name;
          if (sku && !asString(existing.sku)) patch.sku = sku;
          if (vendor && !asString(existing.vendor)) patch.vendor = vendor;
          if (category && !asString(existing.category)) patch.category = category;
          if (unit && !asString(existing.unit)) patch.unit = unit;
          if (accountCode && !asString(existing.accountCode)) patch.accountCode = accountCode;
          if (purchaseAccountCode && !asString(existing.purchaseAccountCode)) patch.purchaseAccountCode = purchaseAccountCode;
          if (salesTaxCode && !asString(existing.salesTaxCode)) patch.salesTaxCode = salesTaxCode;
          if (purchaseTaxCode && !asString(existing.purchaseTaxCode)) patch.purchaseTaxCode = purchaseTaxCode;
          if (hasDiscountPercent) patch.discountPercent = discountPercent;
          if (hasCost) patch.cost = cost;
          if (hasPrice) patch.price = price;
          if (hasOnHand) patch.onHand = onHand;
          if (hasReorderAt) patch.reorderAt = reorderAt;
          if (hasOnOrder) patch.onOrder = onOrder;
          if (hasUnitCost) patch.unitCost = unitCost;

          const existingOperation = operationsByRowKey.get(existing.id);
          if (existingOperation) {
            existingOperation.entity = {
              ...existingOperation.entity,
              ...patch
            };
            if (i < existingOperation.index) {
              existingOperation.index = i;
            }
          } else {
            operationsByRowKey.set(existing.id, {
              index: i,
              mode: "update",
              entity: patch
            });
          }

          const mergedItem = toInventoryItem({
            ...existing,
            ...patch,
            rowKey: existing.id
          });
          Object.assign(existing, mergedItem);
          addInventoryLookupItem(lookup, existing);
        } catch (error) {
          errors.push({
            index: i,
            error: asString(error && error.message) || "Import row failed."
          });
        }
      }

      const operations = Array.from(operationsByRowKey.values());
      const persisted = await executeInventoryUpserts(inventoryClient, operations, errors);

      context.res = json(200, {
        ok: true,
        created: persisted.created,
        updated: persisted.updated,
        skipped,
        errors
      });
      return;
    }

    if (op === "deleteitem" || op === "delete-item") {
      const id = asString(body.id);
      if (!id) {
        context.res = json(400, { error: "id is required." });
        return;
      }
      await inventoryClient.deleteEntity(tenantId, id);
      context.res = json(200, { ok: true, id });
      return;
    }

    if (op === "upsertneed" || op === "upsert-need") {
      const id = asString(body.id) || randomUUID();
      const partName = asString(body.partName);
      if (!partName) {
        context.res = json(400, { error: "partName is required." });
        return;
      }
      const now = new Date().toISOString();
      await needsClient.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: id,
          sourceType: asString(body.sourceType) || "manual",
          sourceId: asString(body.sourceId),
          scheduleStart: asString(body.scheduleStart),
          scheduleEnd: asString(body.scheduleEnd),
          resource: asString(body.resource),
          customerId: asString(body.customerId),
          customerName: asString(body.customerName),
          vehicle: asString(body.vehicle),
          partName,
          sku: asString(body.sku),
          qty: Math.max(1, Math.floor(asNumber(body.qty, 1))),
          vendorHint: asString(body.vendorHint),
          note: asString(body.note),
          status: normalizeNeedStatus(body.status),
          purchaseOrderId: asString(body.purchaseOrderId),
          createdAt: asString(body.createdAt) || now,
          updatedAt: now
        },
        "Merge"
      );
      const saved = await needsClient.getEntity(tenantId, id);
      context.res = json(200, { ok: true, need: toNeed(saved) });
      return;
    }

    if (op === "setneedstatus" || op === "set-need-status") {
      const id = asString(body.id);
      if (!id) {
        context.res = json(400, { error: "id is required." });
        return;
      }
      await needsClient.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: id,
          status: normalizeNeedStatus(body.status),
          purchaseOrderId: asString(body.purchaseOrderId),
          updatedAt: new Date().toISOString()
        },
        "Merge"
      );
      const saved = await needsClient.getEntity(tenantId, id);
      context.res = json(200, { ok: true, need: toNeed(saved) });
      return;
    }

    if (op === "upsertconnector" || op === "upsert-connector") {
      const id = asString(body.id);
      if (!id) {
        context.res = json(400, { error: "id is required." });
        return;
      }
      const now = new Date().toISOString();
      await connectorsClient.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: id,
          provider: asString(body.provider),
          segment: asString(body.segment),
          status: asString(body.status),
          note: asString(body.note),
          enabled: asBool(body.enabled),
          configured: asBool(body.configured),
          updatedAt: now
        },
        "Merge"
      );
      const saved = await connectorsClient.getEntity(tenantId, id);
      context.res = json(200, { ok: true, connector: toConnector(saved) });
      return;
    }

    if (op === "nexpartping" || op === "nexpart-ping") {
      const startedAt = new Date().toISOString();
      try {
        const result = await callNexpart(nexpart, {
          path: nexpart.pingPath,
          query: { limit: "1", q: asString(body.query) || "brake pad" }
        });
        await connectorsClient.upsertEntity(
          {
            partitionKey: tenantId,
            rowKey: "nexpart",
            configured: true,
            enabled: true,
            status: "connected",
            lastCheckedAt: startedAt,
            lastError: "",
            updatedAt: startedAt
          },
          "Merge"
        );
        context.res = json(200, {
          ok: true,
          provider: "nexpart",
          connected: true,
          statusCode: result.status,
          checkedAt: startedAt
        });
      } catch (err) {
        await connectorsClient.upsertEntity(
          {
            partitionKey: tenantId,
            rowKey: "nexpart",
            configured: nexpart.configured,
            enabled: nexpart.enabled,
            status: nexpart.configured ? "error" : "not-connected",
            lastCheckedAt: startedAt,
            lastError: asString(err && err.message),
            updatedAt: startedAt
          },
          "Merge"
        );
        context.res = json(502, {
          ok: false,
          provider: "nexpart",
          connected: false,
          checkedAt: startedAt,
          error: asString(err && err.message) || "Nexpart ping failed."
        });
      }
      return;
    }

    if (op === "nexpartsearch" || op === "nexpart-search") {
      const query = asString(body.query || body.q);
      const partNumber = asString(body.partNumber || body.sku);
      if (!query && !partNumber) {
        context.res = json(400, { error: "query or partNumber is required." });
        return;
      }

      const result = await callNexpart(nexpart, {
        path: nexpart.searchPath,
        query: {
          q: query,
          partNumber,
          limit: asString(body.limit) || "15"
        }
      });
      const items = normalizeNexpartSearchResults(result.payload);
      context.res = json(200, {
        ok: true,
        provider: "nexpart",
        sourceStatus: result.status,
        items,
        rawCount: parseProviderItems(result.payload).length
      });
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
