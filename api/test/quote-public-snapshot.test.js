const test = require("node:test");
const assert = require("node:assert/strict");
const { TableClient } = require("../_shared/table-client");

test("public quote snapshots never store or return internal notes", async () => {
  const originalClient = TableClient.fromConnectionString;
  const originalStorage = process.env.STORAGE_CONNECTION_STRING;
  const originalEnvironment = process.env.PATHFLOW_ENVIRONMENT;
  const tables = new Map();
  const rows = name => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  TableClient.fromConnectionString = (_connection, name) => ({
    async createTable() {},
    async upsertEntity(entity) {
      const key = `${entity.partitionKey}|${entity.rowKey}`;
      rows(name).set(key, { ...(rows(name).get(key) || {}), ...entity });
    },
    async getEntity(partitionKey, rowKey) {
      const entity = rows(name).get(`${partitionKey}|${rowKey}`);
      if (!entity) throw Object.assign(new Error("Not found"), { statusCode: 404 });
      return { ...entity };
    }
  });
  process.env.STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
  process.env.PATHFLOW_ENVIRONMENT = "development";
  delete require.cache[require.resolve("../quote-response")];
  const quoteResponse = require("../quote-response");

  try {
    const context = { res: null };
    const headers = { host: "localhost:7071", "x-tenant-id": "quote-privacy-test", "x-dev-user-email": "staff@example.test" };
    const publicData = {
      quoteId: "quote-1",
      quoteNumber: "Q-1",
      customerNote: "Please arrive at 7am",
      staffNote: "PRIVATE STAFF NOTE",
      internalNotes: "PRIVATE INTERNAL NOTES",
      lineItems: [{ description: "Repair", quantity: 1, staffNote: "PRIVATE LINE NOTE" }]
    };
    await quoteResponse(context, {
      method: "POST",
      headers,
      body: { op: "publish-snapshot", quoteId: "quote-1", publicToken: "token-1", quoteData: publicData }
    });
    assert.equal(context.res.status, 200);
    const stored = rows("quoteresponses").get("quote-privacy-test|quote-1");
    assert.doesNotMatch(stored.quoteDataJson, /PRIVATE/);
    assert.match(stored.quoteDataJson, /Please arrive at 7am/);

    // A previously published snapshot must also be sanitized on public read.
    stored.quoteDataJson = JSON.stringify(publicData);
    await quoteResponse(context, {
      method: "GET",
      headers,
      query: { quoteId: "quote-1", publicToken: "token-1" }
    });
    assert.equal(context.res.status, 200);
    assert.equal(context.res.body.item.quoteData.customerNote, "Please arrive at 7am");
    assert.equal(JSON.stringify(context.res.body.item.quoteData).includes("PRIVATE"), false);
  } finally {
    TableClient.fromConnectionString = originalClient;
    if (originalStorage === undefined) delete process.env.STORAGE_CONNECTION_STRING;
    else process.env.STORAGE_CONNECTION_STRING = originalStorage;
    if (originalEnvironment === undefined) delete process.env.PATHFLOW_ENVIRONMENT;
    else process.env.PATHFLOW_ENVIRONMENT = originalEnvironment;
    delete require.cache[require.resolve("../quote-response")];
  }
});
