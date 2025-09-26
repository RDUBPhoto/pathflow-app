const {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  SASProtocol,
  generateBlobSASQueryParameters
} = require("@azure/storage-blob");

const CONTAINER = "branding";

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
    const fileName = String((req.body && req.body.fileName) || "").trim();
    const contentType = String((req.body && req.body.contentType) || "application/octet-stream");
    if (!fileName) { context.res = { status: 400, body: { error: "fileName is required" } }; return; }

    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const service = BlobServiceClient.fromConnectionString(conn);
    const container = service.getContainerClient(CONTAINER);
    try { await container.createIfNotExists(); } catch (_) {}

    const { accountName, accountKey } = parseConnString(conn);
    const cred = new StorageSharedKeyCredential(accountName, accountKey);

    const expiresOn = new Date(Date.now() + 10 * 60 * 1000);
    const sas = generateBlobSASQueryParameters(
      {
        containerName: CONTAINER,
        blobName: fileName,
        permissions: BlobSASPermissions.parse("cw"),
        protocol: SASProtocol.Https,
        startsOn: new Date(Date.now() - 60 * 1000),
        expiresOn,
        contentType
      },
      cred
    ).toString();

    const blobClient = container.getBlockBlobClient(fileName);
    context.res = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { uploadUrl: `${blobClient.url}?${sas}`, url: blobClient.url, expiresOn: expiresOn.toISOString() }
    };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, body: { error: "Failed to create SAS", detail: String(err && err.message || err) } };
  }
};
