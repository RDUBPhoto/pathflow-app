const { BlobServiceClient } = require("@azure/storage-blob");
const { resolveTenantId } = require("../_shared/tenant");

const CONTAINER = "branding";
const ORIGIN = process.env.CORS_ORIGIN || "*";
const MAX_BYTES = 5 * 1024 * 1024;

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
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

function blobNameFromUrl(url) {
  const raw = asString(url);
  if (!raw) return "";
  if (!raw.startsWith("http://") && !raw.startsWith("https://")) return "";
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname || "";
    const marker = `/${CONTAINER}/`;
    const idx = path.indexOf(marker);
    if (idx < 0) return "";
    return decodeURIComponent(path.slice(idx + marker.length)).replace(/^\/+/, "");
  } catch {
    return "";
  }
}

function blobNameFromRequestValue(value) {
  const raw = asString(value);
  if (!raw) return "";

  // Stored proxied path (e.g. /api/brandingUpload?blob=tenant%2Flogo.png)
  if (raw.startsWith("/api/brandingUpload")) {
    try {
      const parsed = new URL(raw, "https://local");
      const fromBlob = asString(parsed.searchParams.get("blob"));
      if (fromBlob) return decodeURIComponent(fromBlob).replace(/^\/+/, "");
      const fromLogoUrl = asString(parsed.searchParams.get("logoUrl"));
      if (fromLogoUrl) return blobNameFromRequestValue(fromLogoUrl);
    } catch {
      return "";
    }
  }

  // Raw blob path value (e.g. tenant/logo.png)
  if (!raw.startsWith("http://") && !raw.startsWith("https://") && !raw.startsWith("/")) {
    return raw.replace(/^\/+/, "");
  }

  const fromBlobUrl = blobNameFromUrl(raw);
  return fromBlobUrl ? fromBlobUrl.replace(/^\/+/, "") : "";
}

function buildProxyUrl(blobName) {
  return `/api/brandingUpload?blob=${encodeURIComponent(blobName)}`;
}

module.exports = async function (context, req) {
  try {
    const method = (req.method || "").toUpperCase();
    if (method === "OPTIONS") {
      context.res = { status: 204, headers: cors };
      return;
    }

    const body = asObject(req && req.body);
    const fileName = sanitizeFileName(body.fileName);
    const requestedType = asString(body.contentType) || "application/octet-stream";
    const tenantId = resolveTenantId(req, body);

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
    await container.createIfNotExists();

    if (method === "GET") {
      const query = asObject(req && req.query);
      const target = asString(query.blob || query.logoUrl || body.logoUrl || body.url);
      const blobName = blobNameFromRequestValue(target);
      if (!blobName) {
        context.res = {
          status: 400,
          headers: { "content-type": "application/json", ...cors },
          body: { error: "blob or logoUrl query parameter is required." }
        };
        return;
      }

      const client = container.getBlockBlobClient(blobName);
      const exists = await client.exists();
      if (!exists) {
        context.res = {
          status: 404,
          headers: { "content-type": "application/json", ...cors },
          body: { error: "Logo not found." }
        };
        return;
      }

      const download = await client.download();
      const chunks = [];
      for await (const chunk of download.readableStreamBody) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks);
      context.res = {
        status: 200,
        isRaw: true,
        headers: {
          "content-type": asString(download.contentType) || "application/octet-stream",
          "cache-control": asString(download.cacheControl) || "public, max-age=31536000, immutable",
          ...cors
        },
        body: content
      };
      return;
    }

    if (method === "DELETE") {
      const targetUrl = asString(body.logoUrl || body.url || (req && req.query && req.query.logoUrl));
      const blobName = blobNameFromRequestValue(targetUrl);
      if (!blobName) {
        context.res = {
          status: 400,
          headers: { "content-type": "application/json", ...cors },
          body: { error: "logoUrl is required and must reference a branding blob." }
        };
        return;
      }
      if (!blobName.startsWith(`${tenantId}/`)) {
        context.res = {
          status: 403,
          headers: { "content-type": "application/json", ...cors },
          body: { error: "Cannot delete logo outside tenant scope." }
        };
        return;
      }
      const client = container.getBlockBlobClient(blobName);
      await client.deleteIfExists();
      context.res = {
        status: 200,
        headers: { "content-type": "application/json", ...cors },
        body: { ok: true, deleted: true, tenantId }
      };
      return;
    }

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
        url: buildProxyUrl(blobName),
        blobUrl: blobClient.url,
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
