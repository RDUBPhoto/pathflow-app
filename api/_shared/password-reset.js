const { createHash, randomBytes, randomUUID } = require("node:crypto");

async function issuePasswordReset(client, email) {
  const token = randomBytes(32).toString("hex");
  await client.createEntity({
    partitionKey: "v1", rowKey: createHash("sha256").update(token).digest("hex"),
    email, revision: randomUUID(), used: false,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  });
  return token;
}

async function claimPasswordReset(client, token) {
  if (!/^[a-f0-9]{64}$/.test(token || "")) return null;
  const key = createHash("sha256").update(token).digest("hex");
  let record;
  try { record = await client.getEntity("v1", key); }
  catch (error) { if (error?.statusCode === 404) return null; throw error; }
  if (record.used || !(Date.parse(record.expiresAt) > Date.now()) || !record.revision) return null;
  const consumed = { ...record, used: true, revision: randomUUID() };
  if (typeof client.replaceIfRevision === "function") {
    return await client.replaceIfRevision(consumed, record.revision) ? record.email : null;
  }
  try { await client.updateEntity(consumed, "Replace", { etag: record.etag }); }
  catch (error) { if ([404, 412].includes(error?.statusCode)) return null; throw error; }
  return record.email;
}

module.exports = { issuePasswordReset, claimPasswordReset };
