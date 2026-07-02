const { TableClient } = require("../_shared/table-client");
const { randomUUID } = require("crypto");
const { resolveTenantId } = require("../_shared/tenant");
const { requirePrincipal } = require("../_shared/auth");

const TABLE = "additionalparts";

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

async function getTableClient() {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn, TABLE);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

function normalizeApprovalStatus(value) {
  const normalized = asString(value).toLowerCase();
  if (normalized === "approved") return "approved";
  if (normalized === "declined") return "declined";
  if (normalized === "not_required" || normalized === "not-required" || normalized === "not required") return "not_required";
  return "pending";
}

function normalizeBillingStatus(value) {
  const normalized = asString(value).toLowerCase();
  if (normalized === "quote_update_needed" || normalized === "quote-update-needed") return "quote_update_needed";
  if (normalized === "invoice_update_needed" || normalized === "invoice-update-needed") return "invoice_update_needed";
  if (normalized === "payment_needed" || normalized === "payment-needed") return "payment_needed";
  if (normalized === "added_to_invoice" || normalized === "added-to-invoice") return "added_to_invoice";
  if (normalized === "paid") return "paid";
  return "not_added";
}

function normalizeReviewStatus(value) {
  const normalized = asString(value).toLowerCase();
  if (normalized === "reviewed") return "reviewed";
  return "needs_review";
}

function normalizeStatus(value) {
  const normalized = asString(value).toLowerCase();
  if (normalized === "ordered") return "ordered";
  if (normalized === "received") return "received";
  if (normalized === "installed") return "installed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return "requested";
}

function toAdditionalPart(entity) {
  return {
    id: asString(entity.rowKey),
    jobId: asString(entity.jobId),
    jobNumber: asString(entity.jobNumber),
    relatedScheduleId: asString(entity.relatedScheduleId),
    relatedWorkItemId: asString(entity.relatedWorkItemId),
    relatedQuoteId: asString(entity.relatedQuoteId),
    relatedInvoiceId: asString(entity.relatedInvoiceId),
    relatedInventoryItemId: asString(entity.relatedInventoryItemId),
    vendorId: asString(entity.vendorId),
    vendor: asString(entity.vendor),
    partName: asString(entity.partName),
    sku: asString(entity.sku),
    description: asString(entity.description),
    quantity: asNumber(entity.quantity, 1),
    cost: asNumber(entity.cost, 0),
    markup: asNumber(entity.markup, 0),
    customerPrice: asNumber(entity.customerPrice, 0),
    reasonNotes: asString(entity.reasonNotes),
    addedBy: asString(entity.addedBy),
    addedById: asString(entity.addedById),
    addedAt: asString(entity.addedAt),
    approvalStatus: normalizeApprovalStatus(entity.approvalStatus),
    approvedAt: asString(entity.approvedAt),
    approvedBy: asString(entity.approvedBy),
    approvedById: asString(entity.approvedById),
    billingStatus: normalizeBillingStatus(entity.billingStatus),
    invoiceReviewStatus: normalizeReviewStatus(entity.invoiceReviewStatus),
    reviewedBy: asString(entity.reviewedBy),
    reviewedById: asString(entity.reviewedById),
    reviewedAt: asString(entity.reviewedAt),
    status: normalizeStatus(entity.status),
    createdAt: asString(entity.createdAt),
    updatedAt: asString(entity.updatedAt)
  };
}

async function listParts(client, tenantId) {
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${escapedFilterValue(tenantId)}'` } });
  for await (const entity of iter) out.push(toAdditionalPart(entity));
  return out.sort((a, b) => {
    const ta = Date.parse(asString(a.updatedAt || a.createdAt || a.addedAt));
    const tb = Date.parse(asString(b.updatedAt || b.createdAt || b.addedAt));
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    return asString(a.partName).localeCompare(asString(b.partName), undefined, { sensitivity: "base" });
  });
}

function matchesQuery(part, query) {
  const jobId = asString(query.jobId);
  const jobNumber = asString(query.jobNumber);
  const scheduleId = asString(query.scheduleId);
  const workItemId = asString(query.workItemId);
  const invoiceId = asString(query.invoiceId);

  if (jobId && part.jobId === jobId) return true;
  if (jobNumber && part.jobNumber === jobNumber) return true;
  if (scheduleId && part.relatedScheduleId === scheduleId) return true;
  if (workItemId && part.relatedWorkItemId === workItemId) return true;
  if (invoiceId && (part.relatedInvoiceId === invoiceId || part.relatedQuoteId === invoiceId)) return true;
  return !jobId && !jobNumber && !scheduleId && !workItemId && !invoiceId;
}

function entityFromBody(body, existing, principal) {
  const now = new Date().toISOString();
  const createdAt = asString(existing && existing.createdAt) || asString(body.createdAt) || now;
  const addedAt = asString(existing && existing.addedAt) || asString(body.addedAt) || now;
  const approvalStatus = normalizeApprovalStatus(body.approvalStatus);
  const reviewStatus = normalizeReviewStatus(body.invoiceReviewStatus);
  const approvedAt = approvalStatus === "approved"
    ? asString(body.approvedAt || (existing && existing.approvedAt) || now)
    : asString(body.approvedAt || (existing && existing.approvedAt));
  const reviewedAt = reviewStatus === "reviewed"
    ? asString(body.reviewedAt || (existing && existing.reviewedAt) || now)
    : asString(body.reviewedAt || (existing && existing.reviewedAt));

  return {
    jobId: asString(body.jobId || (existing && existing.jobId)),
    jobNumber: asString(body.jobNumber || (existing && existing.jobNumber)),
    relatedScheduleId: asString(body.relatedScheduleId || (existing && existing.relatedScheduleId)),
    relatedWorkItemId: asString(body.relatedWorkItemId || (existing && existing.relatedWorkItemId)),
    relatedQuoteId: asString(body.relatedQuoteId || (existing && existing.relatedQuoteId)),
    relatedInvoiceId: asString(body.relatedInvoiceId || (existing && existing.relatedInvoiceId)),
    relatedInventoryItemId: asString(body.relatedInventoryItemId || (existing && existing.relatedInventoryItemId)),
    vendorId: asString(body.vendorId),
    vendor: asString(body.vendor || body.vendorHint || body.supplier),
    partName: asString(body.partName || body.name || body.description),
    sku: asString(body.sku),
    description: asString(body.description),
    quantity: Math.max(1, asNumber(body.quantity, 1)),
    cost: Math.max(0, asNumber(body.cost, 0)),
    markup: Math.max(0, asNumber(body.markup, 0)),
    customerPrice: Math.max(0, asNumber(body.customerPrice, 0)),
    reasonNotes: asString(body.reasonNotes || body.notes),
    addedBy: asString(body.addedBy) || asString(existing && existing.addedBy) || asString(principal && (principal.displayName || principal.email)),
    addedById: asString(body.addedById) || asString(existing && existing.addedById) || asString(principal && (principal.userId || principal.email)),
    addedAt,
    approvalStatus,
    approvedAt,
    approvedBy: asString(body.approvedBy || (existing && existing.approvedBy)),
    approvedById: asString(body.approvedById || (existing && existing.approvedById)),
    billingStatus: normalizeBillingStatus(body.billingStatus),
    invoiceReviewStatus: reviewStatus,
    reviewedBy: reviewStatus === "reviewed"
      ? (asString(body.reviewedBy) || asString(existing && existing.reviewedBy) || asString(principal && (principal.displayName || principal.email)))
      : asString(body.reviewedBy || (existing && existing.reviewedBy)),
    reviewedById: reviewStatus === "reviewed"
      ? (asString(body.reviewedById) || asString(existing && existing.reviewedById) || asString(principal && (principal.userId || principal.email)))
      : asString(body.reviewedById || (existing && existing.reviewedById)),
    reviewedAt,
    status: normalizeStatus(body.status),
    createdAt,
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
      const id = queryParam(req, "id");
      if (id) {
        try {
          const entity = await client.getEntity(tenantId, id);
          context.res = json(200, { ok: true, part: toAdditionalPart(entity) });
        } catch (_) {
          context.res = json(404, { error: "Additional part not found." });
        }
        return;
      }

      const query = {
        jobId: queryParam(req, "jobId"),
        jobNumber: queryParam(req, "jobNumber"),
        scheduleId: queryParam(req, "scheduleId"),
        workItemId: queryParam(req, "workItemId"),
        invoiceId: queryParam(req, "invoiceId")
      };
      const parts = (await listParts(client, tenantId)).filter(part => matchesQuery(part, query));
      context.res = json(200, { ok: true, parts });
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { error: "Method not allowed" });
      return;
    }

    const op = asString(body.op || body.operation || body.action || "upsert").toLowerCase();
    if (op !== "create" && op !== "update" && op !== "upsert") {
      context.res = json(400, { error: "Unknown operation." });
      return;
    }

    const id = asString(body.id) || randomUUID();
    let existing = null;
    if (asString(body.id)) {
      try {
        existing = await client.getEntity(tenantId, id);
      } catch (_) {}
    }

    const entity = entityFromBody(body, existing, principal);
    if (!entity.jobId && !entity.jobNumber && !entity.relatedScheduleId && !entity.relatedWorkItemId) {
      context.res = json(400, { error: "A job identity is required." });
      return;
    }
    if (!entity.partName && !entity.sku) {
      context.res = json(400, { error: "partName or sku is required." });
      return;
    }

    await client.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey: id,
        ...entity
      },
      "Merge"
    );
    const saved = await client.getEntity(tenantId, id);
    context.res = json(200, { ok: true, part: toAdditionalPart(saved) });
  } catch (err) {
    if (context.log && typeof context.log.error === "function") context.log.error(err);
    context.res = json(500, {
      error: "Server error",
      detail: String((err && err.message) || err)
    });
  }
};
