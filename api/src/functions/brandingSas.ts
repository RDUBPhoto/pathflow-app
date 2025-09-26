import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters
} from "@azure/storage-blob";

const CONTAINER = "branding";

type SasBody = {
  fileName: string;
  contentType?: string;
};

function parseConnString(conn: string) {
  const parts = conn.split(";").reduce<Record<string, string>>((acc, kv) => {
    const [k, v] = kv.split("=", 2);
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  const accountName = parts["AccountName"];
  const accountKey = parts["AccountKey"];
  if (!accountName || !accountKey) throw new Error("Invalid STORAGE_CONNECTION_STRING; missing AccountName/AccountKey");
  return { accountName, accountKey };
}

export async function brandingSas(req: HttpRequest, ctx: InvocationContext): Promise<HttpResponseInit> {
  try {
    const body = (await req.json()) as SasBody;
    const fileName = (body?.fileName || "").toString().trim();
    const contentType = (body?.contentType || "application/octet-stream").toString();

    if (!fileName) {
      return { status: 400, jsonBody: { error: "fileName is required" } };
    }

    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) {
      return { status: 500, jsonBody: { error: "Missing STORAGE_CONNECTION_STRING" } };
    }

    const service = BlobServiceClient.fromConnectionString(conn);
    const container = service.getContainerClient(CONTAINER);
    await container.createIfNotExists({ access: "blob" });

    const { accountName, accountKey } = parseConnString(conn);
    const cred = new StorageSharedKeyCredential(accountName, accountKey);

    const expiresOn = new Date(Date.now() + 10 * 60 * 1000);
    const sasParams = generateBlobSASQueryParameters(
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
    const uploadUrl = `${blobClient.url}?${sasParams}`;
    const publicUrl = blobClient.url;

    return {
      status: 200,
      jsonBody: { uploadUrl, url: publicUrl, expiresOn: expiresOn.toISOString() }
    };
  } catch (err: any) {
    ctx.error?.(err);
    return { status: 500, jsonBody: { error: "Failed to create SAS", detail: err?.message || String(err) } };
  }
}

app.http("brandingSas", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: brandingSas
});
