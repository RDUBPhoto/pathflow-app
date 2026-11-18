const { TableClient } = require("../_shared/table-client");
const { resolveTenantId } = require("../_shared/tenant");
const { requirePrincipal, readHeader, escapedFilterValue } = require("../_shared/auth");
const {
  parseVendorEmail,
  findBestLineMatch,
  applyParsedEmailToOrder,
  toPurchaseOrder
} = require("../_shared/parts-email-intake");

const PURCHASE_ORDER_TABLE = "purchaseorders";
const LOCAL_TEST_ENABLED_ENV = "PARTS_EMAIL_INTAKE_HTTP_ENABLED";

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

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body
  };
}

function isLoopbackHost(value) {
  const raw = asString(value).split(",")[0].trim().toLowerCase();
  const host = raw.split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

function isLocalTestRequest(req) {
  if (String(process.env[LOCAL_TEST_ENABLED_ENV] || "").toLowerCase() === "true") return true;
  const host = readHeader(req && req.headers, "x-forwarded-host") || readHeader(req && req.headers, "host");
  return isLoopbackHost(host);
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

async function listPurchaseOrders(client, tenantId) {
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${escapedFilterValue(tenantId)}'` } });
  for await (const entity of iter) {
    out.push(toPurchaseOrder(entity));
  }
  return out;
}

function summarizeLines(lines) {
  return Number(lines.reduce((sum, line) => sum + Number(line.lineTotal || 0), 0).toFixed(2));
}

module.exports = async function (context, req) {
  const method = asString(req && req.method).toUpperCase() || "POST";
  const body = asObject(req && req.body);
  const tenantId = resolveTenantId(req, body);

  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }
  if (method !== "POST") {
    context.res = json(405, { error: "Method not allowed" });
    return;
  }

  const principal = await requirePrincipal(context, req);
  if (!principal) return;

  if (!isLocalTestRequest(req)) {
    context.res = json(403, {
      error: "Parts email intake HTTP testing is local-only until mailbox connectors are enabled."
    });
    return;
  }

  try {
    const parsed = parseVendorEmail(body);
    if (!parsed.message && !parsed.subject && !parsed.trackingNumber && !parsed.orderNumber) {
      context.res = json(400, { error: "Paste a vendor email subject/message or provide tracking/order fields." });
      return;
    }

    const purchaseClient = await getTableClient(PURCHASE_ORDER_TABLE);
    const orders = await listPurchaseOrders(purchaseClient, tenantId);
    const match = findBestLineMatch(orders, parsed);

    if (!match.matched) {
      context.res = json(202, {
        ok: true,
        matched: false,
        reviewRequired: true,
        reason: match.reason,
        parsed: {
          orderNumber: parsed.orderNumber,
          trackingNumber: parsed.trackingNumber,
          carrier: parsed.carrier,
          etaDate: parsed.etaDate,
          vendorInvoiceNumber: parsed.vendorInvoiceNumber,
          sku: parsed.sku,
          partName: parsed.partName
        },
        candidates: match.candidates
      });
      return;
    }

    const now = new Date().toISOString();
    const applied = applyParsedEmailToOrder(match.order, match.line.lineId, parsed, now);
    if (!applied.updated) {
      context.res = json(409, { error: "Matched purchase order line could not be updated." });
      return;
    }

    await purchaseClient.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey: match.order.id,
        linesJson: JSON.stringify(applied.lines),
        subtotal: summarizeLines(applied.lines),
        updatedAt: now
      },
      "Merge"
    );

    const saved = await purchaseClient.getEntity(tenantId, match.order.id);
    const order = toPurchaseOrder(saved);
    const line = order.lines.find(item => item.lineId === match.line.lineId) || null;
    context.res = json(200, {
      ok: true,
      matched: true,
      reviewRequired: false,
      match: {
        purchaseOrderId: order.id,
        lineId: match.line.lineId,
        score: match.score,
        candidates: match.candidates
      },
      parsed: {
        orderNumber: parsed.orderNumber,
        trackingNumber: parsed.trackingNumber,
        carrier: parsed.carrier,
        etaDate: parsed.etaDate,
        vendorInvoiceNumber: parsed.vendorInvoiceNumber,
        sku: parsed.sku,
        partName: parsed.partName
      },
      order,
      line
    });
  } catch (err) {
    context.log.error(err);
    context.res = json(500, {
      error: "Could not process parts vendor email.",
      detail: String((err && err.message) || err)
    });
  }
};
