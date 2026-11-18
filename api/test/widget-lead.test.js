const test = require("node:test");
const assert = require("node:assert/strict");

const { TableClient } = require("../_shared/table-client");

function createInMemoryTables(failingTables = new Set()) {
  const tables = new Map();

  function tableRows(tableName) {
    if (!tables.has(tableName)) tables.set(tableName, new Map());
    return tables.get(tableName);
  }

  function client(tableName) {
    if (failingTables.has(tableName)) throw new Error(`Injected ${tableName} outage`);
    const rows = tableRows(tableName);
    return {
      async createTable() {},
      async getEntity(partitionKey, rowKey) {
        const entity = rows.get(`${partitionKey}|${rowKey}`);
        if (!entity) throw new Error("Entity not found");
        return { ...entity };
      },
      async upsertEntity(entity) {
        const key = `${entity.partitionKey}|${entity.rowKey}`;
        rows.set(key, { ...(rows.get(key) || {}), ...entity });
      },
      listEntities() {
        return (async function* () {
          for (const entity of rows.values()) yield { ...entity };
        })();
      }
    };
  }

  return { client, tables };
}

async function runWidgetLead({ failingTables = new Set(), tenantId = "Widget Test Shop", formBody } = {}) {
  const originalFromConnectionString = TableClient.fromConnectionString;
  const originalStorageConnection = process.env.STORAGE_CONNECTION_STRING;
  const originalSmsMode = process.env.SMS_MODE;
  const memory = createInMemoryTables(failingTables);

  TableClient.fromConnectionString = (_connectionString, tableName) => memory.client(tableName);
  process.env.STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
  process.env.SMS_MODE = "mock";

  delete require.cache[require.resolve("../widget-lead")];
  const widgetLead = require("../widget-lead");
  const errors = [];
  const warnings = [];
  const context = {
    log: {
      warn(...args) { warnings.push(args); },
      error(...args) { errors.push(args); }
    },
    res: null
  };

  try {
    await widgetLead(context, {
      method: "POST",
      headers: {
        host: "localhost:7071",
        "x-tenant-id": tenantId
      },
      body: formBody || {
        source: "admin-widget-test",
        name: "Regression Lead",
        email: "widget-regression@example.test",
        phone: "+15555550123",
        message: "Widget handler regression check",
        smsOptIn: true,
        consentMethod: "web-checkbox",
        smsConsentVersion: "v1"
      }
    });
    return { context, errors, warnings, memory };
  } finally {
    TableClient.fromConnectionString = originalFromConnectionString;
    if (originalStorageConnection === undefined) delete process.env.STORAGE_CONNECTION_STRING;
    else process.env.STORAGE_CONNECTION_STRING = originalStorageConnection;
    if (originalSmsMode === undefined) delete process.env.SMS_MODE;
    else process.env.SMS_MODE = originalSmsMode;
    delete require.cache[require.resolve("../widget-lead")];
  }
}

test("opted-in widget lead completes the real handler path", async () => {
  const { context, errors, warnings } = await runWidgetLead();

  assert.equal(context.res.status, 200);
  assert.equal(context.res.body.ok, true);
  assert.equal(context.res.body.tenantId, "widget-test-shop");
  assert.equal(context.res.body.customerCreated, true);
  assert.equal(context.res.body.leadCreated, true);
  assert.equal(context.res.body.sms.confirmationAttempted, true);
  assert.equal(context.res.body.sms.confirmationSent, true);
  assert.equal(context.res.body.sms.confirmationSimulated, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("SMS dependency failure cannot turn a captured lead into an HTTP 500", async () => {
  const { context, errors, warnings } = await runWidgetLead({
    failingTables: new Set(["smssenders"]),
    tenantId: "Widget SMS Outage Shop"
  });

  assert.equal(context.res.status, 200);
  assert.equal(context.res.body.ok, true);
  assert.equal(context.res.body.customerCreated, true);
  assert.equal(context.res.body.leadCreated, true);
  assert.equal(context.res.body.sms.confirmationAttempted, true);
  assert.equal(context.res.body.sms.confirmationSent, false);
  assert.equal(context.res.body.sms.confirmationStatus, "failed");
  assert.match(context.res.body.sms.confirmationError, /Injected smssenders outage/);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 1);
});

test("a cross-origin form can request a callback without VIN or SMS consent", async () => {
  const formBody = Buffer.from(new URLSearchParams({
    firstName: "Callback", lastName: "Customer", phone: "+15555550123",
    message: "Please call about a lift kit.", smsOptIn: "false"
  }).toString());
  const { context, memory } = await runWidgetLead({ formBody });
  assert.equal(context.res.status, 200);
  assert.equal(context.res.body.leadCreated, true);
  assert.equal(context.res.body.sms.confirmationAttempted, false);
  const lead = [...memory.tables.get("workitems").values()][0];
  assert.equal(lead.message, "Please call about a lift kit.");
  assert.equal(lead.vin, "");
});
