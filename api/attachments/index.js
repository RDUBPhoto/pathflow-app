const { BlobServiceClient } = require("@azure/storage-blob");
const { TableClient } = require("../_shared/table-client");
const { randomUUID } = require("crypto");
const { resolveTenantId } = require("../_shared/tenant");
const { requirePrincipal } = require("../_shared/auth");

const TABLE = "attachments";
const CONTAINER = "job-attachments";
const ORIGIN = process.env.CORS_ORIGIN || "*";
const MAX_BYTES = 15 * 1024 * 1024;

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/heic",
  "image/heif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
]);

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(value, fallback = false) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return fallback;
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
    headers: { "content-type": "application/json", ...cors },
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

function sanitizeFileName(name) {
  const raw = asString(name);
  const safe = raw
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
  return safe || `attachment-${Date.now()}`;
}

function normalizeCategory(value) {
  const normalized = asString(value).toLowerCase().replace(/-/g, "_");
  if (normalized === "receipt") return "receipt";
  if (normalized === "vendor_invoice") return "vendor_invoice";
  if (normalized === "photo") return "photo";
  if (normalized === "document") return "document";
  return "other";
}

function parseDataUrl(dataUrl) {
  const value = asString(dataUrl);
  const match = /^data:([^;,]+)?;base64,(.+)$/i.exec(value);
  if (!match) return null;
  return {
    contentType: asString(match[1]) || "application/octet-stream",
    base64: asString(match[2]).replace(/\s+/g, "")
  };
}

function decodeBase64(base64Value) {
  const cleaned = asString(base64Value).replace(/\s+/g, "");
  if (!cleaned) return Buffer.alloc(0);
  return Buffer.from(cleaned, "base64");
}

function inferContentType(fileName, fallback) {
  const explicit = asString(fallback).toLowerCase();
  if (explicit && explicit !== "application/octet-stream") return explicit;
  const ext = asString(fileName).toLowerCase().split(".").pop();
  if (ext === "pdf") return "application/pdf";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "heic") return "image/heic";
  if (ext === "heif") return "image/heif";
  if (ext === "doc") return "application/msword";
  if (ext === "docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return explicit || "application/octet-stream";
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

async function getContainerClient() {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const service = BlobServiceClient.fromConnectionString(conn);
  const container = service.getContainerClient(CONTAINER);
  await container.createIfNotExists();
  return container;
}

function toAttachment(entity) {
  const id = asString(entity.rowKey);
  return {
    id,
    jobId: asString(entity.jobId),
    jobNumber: asString(entity.jobNumber),
    relatedScheduleId: asString(entity.relatedScheduleId),
    relatedWorkItemId: asString(entity.relatedWorkItemId),
    relatedInventoryNeedId: asString(entity.relatedInventoryNeedId),
    jobPartId: asString(entity.jobPartId || entity.relatedInventoryNeedId),
    relatedAdditionalPartId: asString(entity.relatedAdditionalPartId),
    relatedPurchaseOrderId: asString(entity.relatedPurchaseOrderId),
    relatedPurchaseOrderLineId: asString(entity.relatedPurchaseOrderLineId),
    relatedVendorId: asString(entity.relatedVendorId),
    fileName: asString(entity.fileName),
    originalFileName: asString(entity.originalFileName),
    contentType: asString(entity.contentType),
    size: asNumber(entity.size, 0),
    blobPath: asString(entity.blobPath),
    url: `/api/attachments?id=${encodeURIComponent(id)}&download=1`,
    category: normalizeCategory(entity.category),
    description: asString(entity.description),
    uploadedBy: asString(entity.uploadedBy),
    uploadedById: asString(entity.uploadedById),
    uploadedAt: asString(entity.uploadedAt),
    isArchived: asBool(entity.isArchived, false),
    createdAt: asString(entity.createdAt),
    updatedAt: asString(entity.updatedAt)
  };
}

async function listAttachments(client, tenantId) {
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${escapedFilterValue(tenantId)}'` } });
  for await (const entity of iter) out.push(toAttachment(entity));
  return out.sort((a, b) => {
    const ta = Date.parse(asString(a.uploadedAt || a.createdAt));
    const tb = Date.parse(asString(b.uploadedAt || b.createdAt));
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    return asString(a.originalFileName).localeCompare(asString(b.originalFileName), undefined, { sensitivity: "base" });
  });
}

function matchesQuery(item, query) {
  if (item.isArchived && !query.includeArchived) return false;
  if (query.jobId && item.jobId !== query.jobId) return false;
  if (query.jobNumber && item.jobNumber !== query.jobNumber) return false;
  if (query.scheduleId && item.relatedScheduleId !== query.scheduleId) return false;
  if (query.workItemId && item.relatedWorkItemId !== query.workItemId) return false;
  if (query.inventoryNeedId && item.relatedInventoryNeedId !== query.inventoryNeedId && item.jobPartId !== query.inventoryNeedId) return false;
  if (query.additionalPartId && item.relatedAdditionalPartId !== query.additionalPartId) return false;
  if (query.purchaseOrderId && item.relatedPurchaseOrderId !== query.purchaseOrderId) return false;
  if (query.vendorId && item.relatedVendorId !== query.vendorId) return false;
  return true;
}

function entityFromBody(body, id, blobPath, payloadSize, principal, existing) {
  const now = new Date().toISOString();
  return {
    partitionKey: asString(body.tenantId),
    rowKey: id,
    jobId: asString(body.jobId || (existing && existing.jobId)),
    jobNumber: asString(body.jobNumber || (existing && existing.jobNumber)),
    relatedScheduleId: asString(body.relatedScheduleId || (existing && existing.relatedScheduleId)),
    relatedWorkItemId: asString(body.relatedWorkItemId || (existing && existing.relatedWorkItemId)),
    relatedInventoryNeedId: asString(body.relatedInventoryNeedId || body.jobPartId || (existing && (existing.relatedInventoryNeedId || existing.jobPartId))),
    jobPartId: asString(body.jobPartId || body.relatedInventoryNeedId || (existing && (existing.jobPartId || existing.relatedInventoryNeedId))),
    relatedAdditionalPartId: asString(body.relatedAdditionalPartId || (existing && existing.relatedAdditionalPartId)),
    relatedPurchaseOrderId: asString(body.relatedPurchaseOrderId || (existing && existing.relatedPurchaseOrderId)),
    relatedPurchaseOrderLineId: asString(body.relatedPurchaseOrderLineId || (existing && existing.relatedPurchaseOrderLineId)),
    relatedVendorId: asString(body.relatedVendorId || body.vendorId || (existing && existing.relatedVendorId)),
    fileName: asString(body.fileName || (existing && existing.fileName)),
    originalFileName: asString(body.originalFileName || body.fileName || (existing && existing.originalFileName)),
    contentType: asString(body.contentType || (existing && existing.contentType)),
    size: payloadSize || asNumber(existing && existing.size, 0),
    blobPath: asString(blobPath || (existing && existing.blobPath)),
    category: normalizeCategory(body.category || (existing && existing.category)),
    description: asString(body.description || body.notes || (existing && existing.description)),
    uploadedBy: asString(body.uploadedBy || (existing && existing.uploadedBy)) || asString(principal && (principal.displayName || principal.email)),
    uploadedById: asString(body.uploadedById || (existing && existing.uploadedById)) || asString(principal && (principal.userId || principal.email)),
    uploadedAt: asString(body.uploadedAt || (existing && existing.uploadedAt)) || now,
    isArchived: asBool(body.isArchived, asBool(existing && existing.isArchived, false)),
    createdAt: asString(existing && existing.createdAt) || now,
    updatedAt: now
  };
}

module.exports = async function (context, req) {
  const method = asString(req.method || "GET").toUpperCase();
  const body = asObject(req.body);
  const tenantId = resolveTenantId(req, body);
  if (method === "OPTIONS") {
    context.res = { status: 204, headers: cors };
    return;
  }
  const principal = await requirePrincipal(context, req);
  if (!principal) return;

  try {
    const table = await getTableClient();
    const container = await getContainerClient();

    if (method === "GET") {
      const id = queryParam(req, "id");
      const download = asBool(queryParam(req, "download"), false);
      if (id) {
        let entity;
        try {
          entity = await table.getEntity(tenantId, id);
        } catch (_) {
          context.res = json(404, { error: "Attachment not found." });
          return;
        }
        const attachment = toAttachment(entity);
        if (!download) {
          context.res = json(200, { ok: true, attachment });
          return;
        }
        const blobClient = container.getBlockBlobClient(attachment.blobPath);
        if (!(await blobClient.exists())) {
          context.res = json(404, { error: "Attachment file not found." });
          return;
        }
        const result = await blobClient.download();
        const chunks = [];
        for await (const chunk of result.readableStreamBody) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        context.res = {
          status: 200,
          isRaw: true,
          headers: {
            "content-type": attachment.contentType || "application/octet-stream",
            "content-disposition": `inline; filename="${attachment.originalFileName || attachment.fileName || "attachment"}"`,
            "cache-control": "private, max-age=300",
            ...cors
          },
          body: Buffer.concat(chunks)
        };
        return;
      }

      const query = {
        jobId: queryParam(req, "jobId"),
        jobNumber: queryParam(req, "jobNumber"),
        scheduleId: queryParam(req, "scheduleId"),
        workItemId: queryParam(req, "workItemId"),
        inventoryNeedId: queryParam(req, "inventoryNeedId") || queryParam(req, "jobPartId"),
        additionalPartId: queryParam(req, "additionalPartId"),
        purchaseOrderId: queryParam(req, "purchaseOrderId"),
        vendorId: queryParam(req, "vendorId"),
        includeArchived: asBool(queryParam(req, "includeArchived"), false)
      };
      const attachments = (await listAttachments(table, tenantId)).filter(item => matchesQuery(item, query));
      context.res = json(200, { ok: true, attachments });
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { error: "Method not allowed" });
      return;
    }

    const op = asString(body.op || body.operation || body.action || "upload").toLowerCase();
    if (op === "archive") {
      const id = asString(body.id);
      if (!id) {
        context.res = json(400, { error: "id is required." });
        return;
      }
      await table.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: id,
          isArchived: true,
          updatedAt: new Date().toISOString()
        },
        "Merge"
      );
      const saved = await table.getEntity(tenantId, id);
      context.res = json(200, { ok: true, attachment: toAttachment(saved) });
      return;
    }

    if (op !== "upload" && op !== "create") {
      context.res = json(400, { error: "Unknown operation." });
      return;
    }

    const id = randomUUID();
    const originalFileName = sanitizeFileName(body.originalFileName || body.fileName);
    let contentType = inferContentType(originalFileName, body.contentType);
    let payload = Buffer.alloc(0);
    const parsedDataUrl = parseDataUrl(body.fileDataUrl);
    if (parsedDataUrl) {
      contentType = inferContentType(originalFileName, parsedDataUrl.contentType || contentType);
      payload = decodeBase64(parsedDataUrl.base64);
    } else if (body.fileBase64) {
      payload = decodeBase64(body.fileBase64);
    }

    if (!payload.length) {
      context.res = json(400, { error: "fileDataUrl or fileBase64 is required." });
      return;
    }
    if (payload.length > MAX_BYTES) {
      context.res = json(400, { error: "Attachment must be 15MB or smaller." });
      return;
    }
    if (!ALLOWED_TYPES.has(contentType)) {
      context.res = json(400, { error: "Unsupported file type." });
      return;
    }
    if (!asString(body.jobId) && !asString(body.jobNumber) && !asString(body.relatedPurchaseOrderId)) {
      context.res = json(400, { error: "A job or purchase order relationship is required." });
      return;
    }

    const date = new Date();
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const blobPath = `${tenantId}/${yyyy}/${mm}/${id}-${originalFileName}`;
    const blob = container.getBlockBlobClient(blobPath);
    await blob.uploadData(payload, {
      blobHTTPHeaders: {
        blobContentType: contentType,
        blobCacheControl: "private, max-age=300"
      }
    });

    const entity = entityFromBody(
      {
        ...body,
        tenantId,
        fileName: `${id}-${originalFileName}`,
        originalFileName,
        contentType
      },
      id,
      blobPath,
      payload.length,
      principal,
      null
    );
    await table.upsertEntity(entity, "Merge");
    const saved = await table.getEntity(tenantId, id);
    context.res = json(200, { ok: true, attachment: toAttachment(saved) });
  } catch (err) {
    if (context.log && typeof context.log.error === "function") context.log.error(err);
    context.res = json(500, {
      error: "Server error",
      detail: String((err && err.message) || err)
    });
  }
};
