const { BlobSASPermissions, BlobServiceClient, SASProtocol, StorageSharedKeyCredential, generateBlobSASQueryParameters } = require("@azure/storage-blob");

const CONTAINER = "branding";

function parseConnString(conn) {
  const parts = {};
  conn.split(";").forEach(kv => {
    const [k, v] = kv.split("=", 2);
    if (k && v) parts[k.trim()] = v.trim();
  });
  if (!parts.AccountName || !parts.AccountKey) throw new Error("Invalid STORAGE_CONNECTION_STRING");
  return { accountName: parts.AccountName, accountKey: parts.AccountKey };
}

module.exports = async function (context, req) {
  try {
    const { fileName, contentType } = (req.body || {});
    if (!fileName) {
      context.res = { status: 400, body: { error: "fileName is required" } };
      return;
    }

    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) {
      context.res = { status: 500, body: { error: "Missing STORAGE_CONNECTION_STRING" } };
      return;
    }

    const service = BlobServiceClient.fromConnectionString(conn);
    const container = service.getContainerClient(CONTAINER);
    try { await container.createIfNotExists({ access: "blob" }); } catch (_) {}

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

    context.res = {
      status: 200,
      body: { uploadUrl, url: publicUrl, expiresOn: expiresOn.toISOString() }
    };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: "Failed to create SAS", detail: String(err && err.message || err) } };
  }
};
