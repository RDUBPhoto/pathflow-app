const {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  SASProtocol,
  generateBlobSASQueryParameters
} = require("@azure/storage-blob");

const CONTAINER = "branding";
const ORIGIN = process.env.CORS_ORIGIN || "http://localhost:4200";

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

module.exports = async function (context, req) {
  try {
    if ((req.method || "").toUpperCase() === "OPTIONS") {
      context.res = { status: 204, headers: cors };
      return;
    }

    const { fileName, contentType } = (req.body || {});
    if (!fileName) { context.res = { status: 400, headers: cors, body: { error: "fileName is required" } }; return; }

    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, headers: cors, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const service = BlobServiceClient.fromConnectionString(conn);
    const container = service.getContainerClient(CONTAINER);
    try { await container.createIfNotExists(); } catch (_) {}

    const { accountName, accountKey } = parseConnString(conn);
    const cred = new StorageSharedKeyCredential(accountName, accountKey);

    const expiresOn = new Date(Date.now() + 10 * 60 * 1000);
    const sas = generateBlobSASQueryParameters(
      {
        containerName: CONTAINER,
        blobName: String(fileName),
        permissions: BlobSASPermissions.parse("cw"),
        protocol: SASProtocol.Https,
        startsOn: new Date(Date.now() - 60 * 1000),
        expiresOn,
        contentType: contentType || "application/octet-stream"
      },
      cred
    ).toString();

    const blobClient = container.getBlockBlobClient(String(fileName));
    const uploadUrl = `${blobClient.url}?${sas}`;
    const publicUrl = blobClient.url;

    context.res = { status: 200, headers: { "content-type": "application/json", ...cors }, body: { uploadUrl, url: publicUrl, expiresOn: expiresOn.toISOString() } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json", ...cors }, body: { error: "Failed to create SAS", detail: String(err && err.message || err) } };
  }
};
