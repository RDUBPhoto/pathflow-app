const test = require("node:test");
const assert = require("node:assert/strict");
const { TableClient } = require("../_shared/table-client");

async function withSmsWebhook(run) {
  const originalClient = TableClient.fromConnectionString;
  const originalEnv = Object.fromEntries(
    ["STORAGE_CONNECTION_STRING", "SMS_MODE", "ACS_CONNECTION_STRING", "ACS_SMS_FROM", "SMS_WEBHOOK_KEY"]
      .map(key => [key, process.env[key]])
  );
  const tables = new Map();
  let failReplySave = false;

  function rows(name) {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  }

  TableClient.fromConnectionString = (_connection, name) => ({
    async createTable() {},
    async createEntity(entity) {
      const key = `${entity.partitionKey}|${entity.rowKey}`;
      if (rows(name).has(key)) throw Object.assign(new Error("Already exists"), { statusCode: 409 });
      rows(name).set(key, { ...entity });
    },
    async getEntity(partitionKey, rowKey) {
      const entity = rows(name).get(`${partitionKey}|${rowKey}`);
      if (!entity) throw new Error("Not found");
      return { ...entity };
    },
    async upsertEntity(entity) {
      if (failReplySave && name === "smsmessages" && entity.direction === "outbound") {
        throw new Error("Injected outbound persistence failure");
      }
      const key = `${entity.partitionKey}|${entity.rowKey}`;
      rows(name).set(key, { ...(rows(name).get(key) || {}), ...entity });
    },
    listEntities(options) {
      const partition = options?.queryOptions?.filter?.match(/PartitionKey eq '([^']+)'/)?.[1];
      return (async function* () {
        for (const entity of rows(name).values()) {
          if (!partition || entity.partitionKey === partition) yield { ...entity };
        }
      })();
    }
  });
  process.env.STORAGE_CONNECTION_STRING = "UseDevelopmentStorage=true";
  process.env.SMS_MODE = "mock";
  delete process.env.ACS_CONNECTION_STRING;
  delete process.env.ACS_SMS_FROM;
  delete process.env.SMS_WEBHOOK_KEY;

  rows("customers").set("sms-regression|customer-1", {
    partitionKey: "sms-regression",
    rowKey: "customer-1",
    name: "Regression Customer",
    phone: "+15555550101"
  });

  delete require.cache[require.resolve("../sms")];
  const sms = require("../sms");
  const event = {
    id: "event-1",
    eventType: "Microsoft.Communication.SMSReceived",
    data: {
      messageId: "provider-1",
      from: "+15555550101",
      to: "+15555550100",
      message: "YES",
      receivedTimestamp: "2026-10-08T21:21:07Z"
    }
  };
  const invoke = async () => {
    const context = { log: { info() {}, error() {} }, res: null };
    await sms(context, { method: "POST", headers: {}, query: { scope: "webhook" }, body: [event] });
    return context.res;
  };

  try {
    await run({ invoke, rows, event, setFailReplySave(value) { failReplySave = value; }, setMode(value) { process.env.SMS_MODE = value; } });
  } finally {
    TableClient.fromConnectionString = originalClient;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve("../sms")];
  }
}

test("YES updates consent and creates exactly one confirmation on duplicate delivery", async () => {
  await withSmsWebhook(async ({ invoke, rows }) => {
    const first = await invoke();
    const second = await invoke();
    const messages = [...rows("smsmessages").values()];

    assert.equal(first.status, 200);
    assert.equal(first.body.details[0].autoReplySent, true);
    assert.equal(second.status, 200);
    assert.equal(second.body.details[0].duplicate, true);
    assert.equal(messages.filter(row => row.direction === "inbound").length, 1);
    assert.equal(messages.filter(row => row.direction === "outbound").length, 1);
    assert.match(messages.find(row => row.direction === "outbound").message, /SMS updates are confirmed/);
    assert.equal(messages.find(row => row.direction === "inbound").keywordReplyStatus, "sent");
    assert.equal(rows("customers").get("sms-regression|customer-1").smsConsentStatus, "opted-in");
  });
});

test("a new inbound service text is assigned to the shop number and creates one lead on replay", async () => {
  await withSmsWebhook(async ({ invoke, rows, event }) => {
    rows("smssenders").set("lookup|15555550100", {
      partitionKey: "lookup", rowKey: "15555550100", tenantId: "destination-shop"
    });
    event.data.message = "Can you install a lift kit?";
    const first = await invoke();
    assert.equal(first.status, 200);
    assert.equal(first.body.details[0].tenantId, "destination-shop");
    const retry = await invoke();
    assert.equal(retry.status, 200);
    const leads = [...rows("workitems").values()];
    assert.equal(leads.length, 1);
    assert.equal(leads[0].message, "Can you install a lift kit?");
    assert.equal(leads[0].source, "sms");
    const inbound = [...rows("smsmessages").values()].find(row => row.direction === "inbound");
    assert.equal(inbound.customerId, leads[0].customerId);
  });
});

test("failed reply returns retryable webhook error and duplicate delivery sends the missing reply", async () => {
  await withSmsWebhook(async ({ invoke, rows, setFailReplySave }) => {
    setFailReplySave(true);
    const failed = await invoke();
    const inbound = [...rows("smsmessages").values()].find(row => row.direction === "inbound");
    assert.equal(failed.status, 500);
    assert.equal(failed.body.errors, 1);
    assert.equal(inbound.keywordReplyStatus, "failed");
    assert.equal([...rows("smsmessages").values()].filter(row => row.direction === "outbound").length, 0);

    setFailReplySave(false);
    const retried = await invoke();
    assert.equal(retried.status, 200);
    assert.equal(retried.body.details[0].duplicate, true);
    assert.equal(retried.body.details[0].autoReplySent, true);
    assert.equal(rows("smsmessages").get(`${inbound.partitionKey}|${inbound.rowKey}`).keywordReplyStatus, "sent");
    assert.equal([...rows("smsmessages").values()].filter(row => row.direction === "inbound").length, 1);
    assert.equal([...rows("smsmessages").values()].filter(row => row.direction === "outbound").length, 1);
  });
});

test("a live-mode configuration gap cannot be reported as a simulated confirmation", async () => {
  await withSmsWebhook(async ({ invoke, rows, setMode }) => {
    setMode("azure");
    const result = await invoke();

    assert.equal(result.status, 500);
    assert.equal(result.body.details[0].reason, "error");
    assert.equal([...rows("smsmessages").values()].filter(row => row.direction === "outbound").length, 0);
    assert.equal([...rows("smsmessages").values()].find(row => row.direction === "inbound").keywordReplyStatus, "failed");
  });
});
