const {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  SASProtocol,
  generateBlobSASQueryParameters
} = require("@azure/storage-blob");
const { resolveTenantId } = require("../_shared/tenant");

const CONTAINER = "branding";
const ORIGIN = process.env.CORS_ORIGIN || "*";

const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function parseConnString(conn) {
  const map = {};
  conn.split(";").forEach(kv => {
    const [k, v] = kv.split("=", 2);
    if (k && v) map[k.trim()] = v.trim();
  });
  if (!map.AccountName || !map.AccountKey) throw new Error("Invalid STORAGE_CONNECTION_STRING");
  return { accountName: map.AccountName, accountKey: map.AccountKey };
}

function sanitizeFileName(name) {
  const raw = String(name || "").trim();
  const safe = raw
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return safe || `logo-${Date.now()}.png`;
}

module.exports = async function (context, req) {
  try {
    if ((req.method || "").toUpperCase() === "OPTIONS") {
      context.res = { status: 204, headers: cors };
      return;
    }

    const body = req.body || {};
    const { fileName, contentType } = body;
    if (!fileName) { context.res = { status: 400, headers: cors, body: { error: "fileName is required" } }; return; }

    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, headers: cors, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }
    const tenantId = resolveTenantId(req, body);

    const service = BlobServiceClient.fromConnectionString(conn);
    const container = service.getContainerClient(CONTAINER);
    await container.createIfNotExists();

    const { accountName, accountKey } = parseConnString(conn);
    const cred = new StorageSharedKeyCredential(accountName, accountKey);

    const expiresOn = new Date(Date.now() + 10 * 60 * 1000);
    const blobName = `${tenantId}/${Date.now()}-${sanitizeFileName(fileName)}`;
    const sas = generateBlobSASQueryParameters(
      {
        containerName: CONTAINER,
        blobName,
        permissions: BlobSASPermissions.parse("cw"),
        protocol: SASProtocol.Https,
        startsOn: new Date(Date.now() - 60 * 1000),
        expiresOn,
        contentType: contentType || "application/octet-stream"
      },
      cred
    ).toString();

    const blobClient = container.getBlockBlobClient(blobName);
    const uploadUrl = `${blobClient.url}?${sas}`;
    const publicUrl = blobClient.url;

    context.res = { status: 200, headers: { "content-type": "application/json", ...cors }, body: { uploadUrl, url: publicUrl, expiresOn: expiresOn.toISOString(), tenantId } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json", ...cors }, body: { error: "Failed to create SAS", detail: String(err && err.message || err) } };
  }
};
