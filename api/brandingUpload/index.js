const { BlobServiceClient } = require("@azure/storage-blob");
const { resolveTenantId } = require("../_shared/tenant");

const CONTAINER = "branding";
const ORIGIN = process.env.CORS_ORIGIN || "*";
const MAX_BYTES = 5 * 1024 * 1024;

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function sanitizeFileName(name) {
  const raw = asString(name);
  const safe = raw
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return safe || `logo-${Date.now()}.png`;
}

function asObject(value) {
  if (!value || typeof value !== "object") return {};
  return value;
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

module.exports = async function (context, req) {
  try {
    if ((req.method || "").toUpperCase() === "OPTIONS") {
      context.res = { status: 204, headers: cors };
      return;
    }

    const body = asObject(req && req.body);
    const fileName = sanitizeFileName(body.fileName);
    const requestedType = asString(body.contentType) || "application/octet-stream";
    const tenantId = resolveTenantId(req, body);

    let contentType = requestedType;
    let payload = Buffer.alloc(0);

    const parsedDataUrl = parseDataUrl(body.fileDataUrl);
    if (parsedDataUrl) {
      contentType = parsedDataUrl.contentType || contentType;
      payload = decodeBase64(parsedDataUrl.base64);
    } else if (body.fileBase64) {
      payload = decodeBase64(body.fileBase64);
    }

    if (!payload.length) {
      context.res = {
        status: 400,
        headers: { "content-type": "application/json", ...cors },
        body: { error: "fileDataUrl or fileBase64 is required" }
      };
      return;
    }

    if (payload.length > MAX_BYTES) {
      context.res = {
        status: 400,
        headers: { "content-type": "application/json", ...cors },
        body: { error: "Logo must be 5MB or smaller." }
      };
      return;
    }

    if (!contentType.startsWith("image/")) {
      context.res = {
        status: 400,
        headers: { "content-type": "application/json", ...cors },
        body: { error: "Only image uploads are supported." }
      };
      return;
    }

    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) {
      context.res = {
        status: 500,
        headers: { "content-type": "application/json", ...cors },
        body: { error: "Missing STORAGE_CONNECTION_STRING" }
      };
      return;
    }

    const service = BlobServiceClient.fromConnectionString(conn);
    const container = service.getContainerClient(CONTAINER);
    try {
      await container.createIfNotExists({ access: "blob" });
    } catch (_) {
      // Ignore if container already exists or access level is unchanged.
    }

    const blobName = `${tenantId}/${Date.now()}-${fileName}`;
    const blobClient = container.getBlockBlobClient(blobName);
    await blobClient.uploadData(payload, {
      blobHTTPHeaders: {
        blobContentType: contentType,
        blobCacheControl: "public, max-age=31536000, immutable"
      }
    });

    context.res = {
      status: 200,
      headers: { "content-type": "application/json", ...cors },
      body: {
        ok: true,
        url: blobClient.url,
        tenantId,
        contentType,
        size: payload.length
      }
    };
  } catch (err) {
    context.log.error(err);
    context.res = {
      status: 500,
      headers: { "content-type": "application/json", ...cors },
      body: { error: "Logo upload failed", detail: String((err && err.message) || err) }
    };
  }
};
