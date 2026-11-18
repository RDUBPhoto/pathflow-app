const crypto = require("crypto");
const { TableClient, isSqlBackendEnabled } = require("../_shared/table-client");
const { readHeader, escapedFilterValue } = require("../_shared/auth");
const {
  normalizeInboundEmailPayload,
  parseVendorEmail,
  findBestLineMatch,
  applyParsedEmailToOrder,
  toPurchaseOrder,
  extractEmails
} = require("../_shared/parts-email-intake");

const PURCHASE_ORDER_TABLE = "purchaseorders";
const SETTINGS_TABLE = "appsettings";
const COMPANY_PARTS_EMAIL_KEY = "parts.company.email";
const ORDERS_INBOX_EMAIL_KEY = "orders.inbox.email";

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

function parseValue(raw) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return raw;
  }
}

function isLoopbackHost(value) {
  const raw = asString(value).split(",")[0].trim().toLowerCase();
  const host = raw.split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

function isLocalRequest(req) {
  const host = readHeader(req && req.headers, "x-forwarded-host") || readHeader(req && req.headers, "host");
  return isLoopbackHost(host);
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(asString(a));
  const right = Buffer.from(asString(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validWebhookToken(req, body) {
  const expected = asString(process.env.PARTS_EMAIL_WEBHOOK_SECRET);
  if (!expected) return isLocalRequest(req);
  const provided =
    readHeader(req && req.headers, "x-pathflow-email-token") ||
    asString(req && req.query && req.query.token) ||
    asString(body && body.token);
  return timingSafeEqual(provided, expected);
}

async function getTableClient(tableName) {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn && !isSqlBackendEnabled()) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn || "sql-backend", tableName);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

async function listPurchaseOrders(client, tenantId) {
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${escapedFilterValue(tenantId)}'` } });
  for await (const entity of iter) out.push(toPurchaseOrder(entity));
  return out;
}

function summarizeLines(lines) {
  return Number(lines.reduce((sum, line) => sum + Number(line.lineTotal || 0), 0).toFixed(2));
}

function requestedTenantId(context, req, body) {
  const routeTenant = asString(context && context.bindingData && context.bindingData.tenantId);
  if (routeTenant) return routeTenant;
  const bodyTenant = asString(body && (body.tenantId || body.tenant || body.workspaceId));
  if (bodyTenant) return bodyTenant;
  const headerTenant = readHeader(req && req.headers, "x-tenant-id");
  return asString(headerTenant);
}

async function tenantIdForRecipient(settingsClient, recipientEmails) {
  const normalized = new Set(recipientEmails.map(email => asString(email).toLowerCase()).filter(Boolean));
  if (!normalized.size) return "";

  const keys = [COMPANY_PARTS_EMAIL_KEY, ORDERS_INBOX_EMAIL_KEY];
  for (const key of keys) {
    const iter = settingsClient.listEntities({ queryOptions: { filter: `RowKey eq '${escapedFilterValue(key)}'` } });
    for await (const entity of iter) {
      const value = asString(parseValue(entity.valueJson)).toLowerCase();
      if (value && normalized.has(value)) return asString(entity.partitionKey);
    }
  }
  return "";
}

async function processVendorEmailForTenant({ tenantId, normalizedEmail, purchaseClient }) {
  const parsed = parseVendorEmail(normalizedEmail);
  if (!parsed.message && !parsed.subject && !parsed.trackingNumber && !parsed.orderNumber) {
    return {
      status: 400,
      body: { error: "Vendor email did not include enough content to parse order or tracking details." }
    };
  }

  const orders = await listPurchaseOrders(purchaseClient, tenantId);
  const match = findBestLineMatch(orders, parsed);

  if (!match.matched) {
    return {
      status: 202,
      body: {
        ok: true,
        matched: false,
        reviewRequired: true,
        reason: match.reason,
        tenantId,
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
      }
    };
  }

  const now = new Date().toISOString();
  const applied = applyParsedEmailToOrder(match.order, match.line.lineId, parsed, now);
  if (!applied.updated) {
    return { status: 409, body: { error: "Matched purchase order line could not be updated." } };
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
  return {
    status: 200,
    body: {
      ok: true,
      matched: true,
      reviewRequired: false,
      tenantId,
      match: {
        purchaseOrderId: order.id,
        lineId: match.line.lineId,
        score: match.score,
        candidates: match.candidates
      },
      order,
      line
    }
  };
}

module.exports = async function (context, req) {
  const method = asString(req && req.method).toUpperCase() || "POST";
  const body = asObject(req && req.body);

  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }
  if (method !== "POST") {
    context.res = json(405, { error: "Method not allowed" });
    return;
  }
  if (!validWebhookToken(req, body)) {
    context.res = json(403, { error: "Parts email webhook is not authorized." });
    return;
  }

  try {
    const normalizedEmail = normalizeInboundEmailPayload(body);
    const recipientEmails = extractEmails(normalizedEmail.to);
    const settingsClient = await getTableClient(SETTINGS_TABLE);
    const purchaseClient = await getTableClient(PURCHASE_ORDER_TABLE);
    const tenantId =
      requestedTenantId(context, req, body) ||
      await tenantIdForRecipient(settingsClient, recipientEmails);

    if (!asString(tenantId)) {
      context.res = json(202, {
        ok: true,
        matched: false,
        reviewRequired: true,
        reason: "Could not resolve a tenant from the inbound email recipient.",
        recipients: recipientEmails
      });
      return;
    }

    const result = await processVendorEmailForTenant({ tenantId, normalizedEmail, purchaseClient });
    context.res = json(result.status, {
      ...result.body,
      email: {
        provider: normalizedEmail.provider,
        from: normalizedEmail.from,
        to: normalizedEmail.to,
        subject: normalizedEmail.subject
      }
    });
  } catch (err) {
    context.log.error(err);
    context.res = json(500, {
      error: "Could not process inbound parts email.",
      detail: String((err && err.message) || err)
    });
  }
};
