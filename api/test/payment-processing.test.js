const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const { EventEmitter } = require("node:events");
const { TableClient } = require("../_shared/table-client");
const charge = require("../payment-charge");
const refund = require("../payment-refund");
const invoiceResponse = require("../invoice-response");
const { listDocuments } = require("../service-documents");

async function fixture(run, provider = "authorize-net", hostedMode = "") {
  const originalTable = TableClient.fromConnectionString;
  const originalRequest = https.request;
  const originalFetch = global.fetch;
  const tenant = "shop-a";
  const environment = {
    STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true", EMAIL_MODE: "mock", SMS_MODE: "mock",
    PATHFLOW_ENVIRONMENT: hostedMode ? "production" : "development", PAYLYNX_SANDBOX_TENANT_ID: tenant,
    PAYLYNX_SANDBOX_SOURCE_KEY: "synthetic-private", PAYLYNX_SANDBOX_TOKENIZATION_KEY: "pk_syntheticPublic",
    PAYLYNX_SANDBOX_PIN: "", WEBSITE_SITE_NAME: hostedMode ? "hosted-fixture" : "",
    PAYLYNX_ACCOUNTS_JSON: hostedMode ? JSON.stringify({ [tenant]: { [hostedMode]: {
      sourceKey: "synthetic-private", tokenizationKey: "pk_syntheticPublic"
    } } }) : ""
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const tables = new Map();
  const rows = name => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  function put(table, row) { rows(table).set(`${row.partitionKey}|${row.rowKey}`, row); }
  const invoice = { partitionKey: tenant, rowKey: "invoice-a", publicToken: "payment-token",
    invoiceNumber: "INV-A", customerId: "customer-a", customerName: "Fixture Customer",
    customerEmail: "fixture@example.test", snapshotPaymentProvider: provider, amount: "125.00",
    invoiceDataJson: JSON.stringify({ total: 125, customerId: "customer-a", lineItems: [] }) };
  put("invoiceresponses", invoice);
  put("lanes", { partitionKey: tenant, rowKey: "invoice-lane", stageKey: "invoiced" });
  put("appsettings", { partitionKey: tenant, rowKey: "billing.paymentProviders",
    valueJson: JSON.stringify({ providers: [{ key: provider, connected: true, mode: hostedMode || "test" }] }) });
  if (hostedMode) {
    const { createHash } = require("node:crypto");
    put("authsessions", { partitionKey: "v1", rowKey: createHash("sha256").update("saved-fixture").digest("hex"),
      email: "staff@example.test", expiresAt: new Date(Date.now() + 60000).toISOString() });
    put("useraccess", { partitionKey: "v1", rowKey: "staff@example.test", email: "staff@example.test",
      status: "active", locationIdsJson: JSON.stringify([tenant]), rolesJson: '["authenticated","admin"]' });
  }
  put("appsettings", { partitionKey: tenant, rowKey: "billing.paymentProviders.authorizeNetCredentials",
    valueJson: JSON.stringify({ apiLoginId: "synthetic", transactionKey: "synthetic" }) });
  TableClient.fromConnectionString = (_, name) => ({
    async createTable() {},
    async getEntity(partitionKey, rowKey) {
      const entity = rows(name).get(`${partitionKey}|${rowKey}`);
      if (!entity) throw Object.assign(new Error("Missing row"), { statusCode: 404 });
      return { ...entity };
    },
    async createEntity(entity) {
      const key = `${entity.partitionKey}|${entity.rowKey}`;
      if (rows(name).has(key)) throw Object.assign(new Error("Row exists"), { statusCode: 409 });
      put(name, { ...entity });
    },
    async upsertEntity(entity) {
      put(name, { ...rows(name).get(`${entity.partitionKey}|${entity.rowKey}`), ...entity });
    },
    async deleteEntity(pk, rk) { rows(name).delete(`${pk}|${rk}`); },
    async *listEntities(options) {
      const partition = options?.queryOptions?.filter?.match(/PartitionKey eq '([^']+)'/)?.[1];
      for (const row of rows(name).values()) if (!partition || row.partitionKey === partition) yield { ...row };
    }
  });
  const processorCalls = [];
  let surcharge = {};
  let chargeStatus = "captured";
  global.fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, hostedMode === "live" ? "api.paylynxgateway.com" : "api.sandbox.paylynxgateway.com");
    assert.equal(options.headers.authorization, `Basic ${Buffer.from("synthetic-private:").toString("base64")}`);
    if (url.endsWith("/surcharge")) return Response.json(surcharge);
    const operation = new URL(url).pathname.split("/").pop();
    if (options.method === "GET") return Response.json({
      id: Number(operation), transaction_details: { type: "charge" },
      amount_details: { amount: 125 }, status_details: { status: chargeStatus }
    });
    assert.ok(["charge", "void", "refund"].includes(operation));
    return new Promise(resolve => processorCalls.push({
      operation,
      payload: JSON.parse(options.body),
      respond(body, status = 200) { resolve(Response.json(body, { status })); }
    }));
  };
  https.request = (options, callback) => {
    assert.equal(options.hostname, "apitest.authorize.net");
    const request = new EventEmitter();
    let requestBody;
    request.write = value => { requestBody = JSON.parse(value); };
    request.end = () => processorCalls.push({
      amount: requestBody.createTransactionRequest.transactionRequest.amount,
      respond(responseCode, transId) {
        const response = new EventEmitter();
        response.statusCode = 200;
        callback(response);
        response.emit("data", Buffer.from(JSON.stringify({ messages: { resultCode: "Ok" },
          transactionResponse: { responseCode, transId, accountNumber: "XXXX1111" } })));
        response.emit("end");
      }
    });
    return request;
  };
  const staffHeaders = hostedMode ? { host: "app.example.test", cookie: "pf_session=saved-fixture" }
    : { host: "localhost:4200", "x-dev-user-email": "staff@example.test" };
  const request = async (options = {}, method = "POST", staff = false) => {
    const context = { log: { error() {}, warn() {} } };
    const card = provider === "paylynx"
      ? { source: "nonce-synthetic" }
      : { cardNumber: "4111111111111111", cardCode: "123" };
    const input = { invoiceId: invoice.rowKey, publicToken: invoice.publicToken, amount: "125.00",
      expiryMonth: "12", expiryYear: "2030", ...card, ...options };
    await charge(context, { method, headers: { "x-tenant-id": tenant, ...(staff ? staffHeaders : {}) },
      ...(method === "GET" ? { query: input } : { body: input }) });
    return context.res;
  };
  const reverse = async (body = {}, staff = true, method = "POST") => {
    const context = { log: { error() {}, warn() {} } };
    const input = { invoiceId: invoice.rowKey, provider: "paylynx", originalTransactionId: "83001", amount: "125.00", ...body };
    await refund(context, { method, headers: { "x-tenant-id": tenant, ...(staff ? staffHeaders : {}) },
      ...(method === "GET" ? { query: input } : { body: input }) });
    return context.res;
  };
  const snapshot = async () => {
    const context = { log: { error() {} } };
    await invoiceResponse(context, { method: "GET", headers: { "x-tenant-id": tenant },
      query: { invoiceId: invoice.rowKey, publicToken: invoice.publicToken } });
    return context.res.body.item;
  };
  const addSharedInvoice = (overrides = {}) => put("servicedocuments", { partitionKey: tenant, rowKey: invoice.rowKey, revision: "fixture",
    documentJson: JSON.stringify({ id: invoice.rowKey, documentType: "invoice", invoiceNumber: "INV-A",
      stage: "accepted", total: 125, paidAmount: 125, ...overrides }) });
  const configureGateway = async mode => {
    const context = { log: { error() {}, warn() {} } };
    await require('../settings')(context, { method: 'POST', headers: { 'x-tenant-id': tenant, ...staffHeaders },
      body: { key: 'billing.paymentProviders', value: {
        defaultProvider: 'paylynx', providers: [{ key: 'paylynx', connected: true, mode }]
      } } });
    return context.res;
  };
  try { await run({ request, rows, processorCalls, reverse, snapshot, invoice, addSharedInvoice,
    configureGateway, setChargeStatus: status => { chargeStatus = status; }, setSurcharge: value => { surcharge = value; } }); }
  finally {
    TableClient.fromConnectionString = originalTable;
    https.request = originalRequest;
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("charge uses the published balance and a confirmed response creates one job and ledger entry", () => fixture(async ({ request, rows, processorCalls }) => {
  assert.equal((await request({ amount: "124.99" })).status, 409);
  assert.equal(processorCalls.length, 0);
  const first = request();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(processorCalls[0].amount, "125.00");
  assert.equal((await request()).status, 409);
  processorCalls[0].respond("1", "83001");
  const confirmed = await first;
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.paidAmount, 125);
  assert.equal(confirmed.body.receiptSent, false);
  assert.equal((await request()).status, 200);
  assert.equal(processorCalls.length, 1);
  assert.equal(rows("paymentledger").size, 1);
  assert.equal(rows("servicejobs").size, 1);
  assert.equal(rows("workitems").size, 1);
  assert.equal(rows("emailmessages").size, 1);
}));

test("PayLynx tokenized checkout records one payment, job and receipt", () => fixture(async ({ request, rows, processorCalls }) => {
  assert.equal((await request({ publicToken: "wrong" }, "GET")).status, 404);
  const config = await request({}, "GET");
  assert.deepEqual(config.body, { ok: true, tokenizationKey: "pk_syntheticPublic", mode: "test" });
  assert.equal((await request({ cardNumber: "4111111111111111" })).status, 400);
  assert.equal((await request({ amount: "1.00" })).status, 409);
  assert.equal(processorCalls.length, 0);

  const first = request();
  await new Promise(resolve => setImmediate(resolve));
  const { payload, respond } = processorCalls[0];
  assert.equal(payload.source, "nonce-synthetic");
  assert.equal(payload.amount, 125);
  assert.equal(payload.card, undefined);
  assert.equal(payload.cvv2, undefined);
  assert.equal(payload.transaction_details.invoice_number, "INV-A");
  assert.equal((await request()).status, 409);
  respond({ status: "Approved", status_code: "A", reference_number: 83001, auth_amount: 125, last_4: "1111" });
  const approved = await first;
  assert.equal(approved.body.provider, "paylynx");
  assert.equal(approved.body.transactionId, "83001");
  assert.equal((await request()).status, 200);
  assert.equal(processorCalls.length, 1);
  assert.equal(rows("paymentledger").size, 1);
  assert.equal(rows("servicejobs").size, 1);
  assert.equal(rows("emailmessages").size, 1);
}, "paylynx"));

test("PayLynx stops before charging when a surcharge applies and keeps mismatched approvals pending", () => fixture(async ({ request, rows, processorCalls, setSurcharge }) => {
  setSurcharge({ card: { type: "percent", value: 3 } });
  assert.equal((await request()).status, 503);
  assert.equal(processorCalls.length, 0);
  setSurcharge({});

  const first = request();
  await new Promise(resolve => setImmediate(resolve));
  processorCalls[0].respond({ status: "Declined", status_code: "D" });
  assert.equal((await first).status, 400);
  const retry = request();
  await new Promise(resolve => setImmediate(resolve));
  processorCalls[1].respond({ status: "Approved", status_code: "A", reference_number: 83002, auth_amount: 126 });
  assert.equal((await retry).status, 409);
  assert.equal((await request()).status, 409);
  assert.equal(processorCalls.length, 2);
  assert.equal(rows("paymentledger").size, 0);
}, "paylynx"));

test("PayLynx sandbox checkout is scoped to its configured development tenant", () => fixture(async ({ request, processorCalls }) => {
  process.env.PAYLYNX_SANDBOX_TENANT_ID = "shop-b";
  assert.equal((await request({}, "GET")).status, 503);
  process.env.PAYLYNX_SANDBOX_TENANT_ID = "shop-a";
  process.env.WEBSITE_SITE_NAME = "hosted-fixture";
  assert.equal((await request()).status, 503);
  assert.equal(processorCalls.length, 0);
}, "paylynx"));

test("an indeterminate processor response leaves the balance pending without another charge", () => fixture(async ({ request, rows, processorCalls }) => {
  const first = request();
  await new Promise(resolve => setImmediate(resolve));
  processorCalls[0].respond("4", "83002");
  assert.equal((await first).status, 409);
  assert.equal((await request()).status, 409);
  assert.equal(processorCalls.length, 1);
  assert.equal(rows("paymentledger").size, 0);
  assert.equal(rows("servicejobs").size, 0);
}));

async function confirmPaylynxCharge(request, calls, reference = 83001) {
  const pending = request();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1).operation, "charge");
  calls.at(-1).respond({ status: "Approved", status_code: "A", reference_number: reference, auth_amount: 125 });
  const response = await pending;
  assert.equal(response.status, 200);
  return response;
}

test("a full PayLynx void reopens the public and staff invoice and allows repayment", () => fixture(async ({
  request, reverse, snapshot, rows, processorCalls, addSharedInvoice
}) => {
  await confirmPaylynxCharge(request, processorCalls);
  addSharedInvoice();
  assert.equal((await reverse({}, false)).status, 401);
  assert.equal((await reverse({ originalTransactionId: "83002" })).status, 404);
  assert.match((await reverse({ amount: "20.00" })).body.error, /only void the full charge/);
  assert.equal(processorCalls.length, 1);

  const denied = reverse();
  await new Promise(resolve => setImmediate(resolve));
  processorCalls[1].respond({ status: "Error" }, 403);
  assert.match((await denied).body.error, /Void permission/);
  assert.equal((await snapshot()).paidAmount, 125);

  const voiding = reverse();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(processorCalls[2].operation, "void");
  assert.deepEqual(processorCalls[2].payload, { reference_number: 83001 });
  assert.equal((await reverse()).status, 409);
  assert.equal((await request()).status, 409);
  processorCalls[2].respond({ status: "Approved", status_code: "A" });
  const completed = await voiding;
  assert.equal(completed.body.operation, "void");
  assert.equal(completed.body.paidAmount, 0);
  assert.deepEqual((await reverse()).body, completed.body);
  const publicInvoice = await snapshot();
  assert.equal(publicInvoice.paidAt, "");
  assert.equal(publicInvoice.paidAmount, 0);
  assert.equal(publicInvoice.amount, "125");
  const [{ document }] = await listDocuments("shop-a");
  assert.equal(document.stage, "sent");
  assert.equal(document.paidAmount, 0);
  assert.equal(document.refundTransactions[0].operation, "void");
  assert.match(document.timeline[0].message, /voided/);

  await confirmPaylynxCharge(request, processorCalls, 83002);
  assert.equal(rows("servicejobs").size, 1);
  assert.equal(rows("paymentledger").size, 2);
  assert.equal((await reverse()).body.paidAmount, 125);
  assert.equal(processorCalls.length, 4);
}, "paylynx"));

test("settled PayLynx charges support scoped partial refunds and stop on indeterminate results", () => fixture(async ({
  request, reverse, snapshot, processorCalls, setChargeStatus
}) => {
  await confirmPaylynxCharge(request, processorCalls);
  setChargeStatus("settled");
  const refunding = reverse({ amount: "10.00" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(processorCalls[1].operation, "refund");
  assert.deepEqual(processorCalls[1].payload, { reference_number: 83001, amount: 10 });
  processorCalls[1].respond({ status: "Approved", status_code: "A", reference_number: 93001 });
  const refunded = await refunding;
  assert.equal(refunded.body.operation, "refund");
  assert.equal(refunded.body.refundTransactionId, "93001");
  assert.equal(refunded.body.paidAmount, 115);
  assert.equal((await snapshot()).amount, "10");
  assert.equal((await reverse({ amount: "10.00" })).body.refundTransactionId, "93001");
  assert.equal((await reverse({ amount: "116.00", alreadyReversed: 10 })).status, 409);

  const pending = reverse({ amount: "10.00", alreadyReversed: 10 });
  await new Promise(resolve => setImmediate(resolve));
  processorCalls[2].respond({ status: "Error" }, 502);
  assert.equal((await pending).status, 409);
  assert.equal((await reverse({ amount: "20.00", alreadyReversed: 10 })).status, 409);
  assert.equal((await request({ amount: "10.00" })).status, 409);
  assert.equal((await snapshot()).paidAmount, 115);
  assert.equal(processorCalls.length, 3);
}, "paylynx"));

test("a valid published legacy link checks out with the current PayLynx default", () => fixture(async ({
  request, snapshot, invoice, processorCalls
}) => {
  invoice.snapshotPaymentProvider = "authorize-net";
  invoice.paymentUrl = "https://pay.pathflow.com/authorize-net/checkout";
  assert.equal((await snapshot()).paymentProvider, "paylynx");
  assert.equal((await request({}, "GET")).body.tokenizationKey, "pk_syntheticPublic");
  await confirmPaylynxCharge(request, processorCalls);
}, "paylynx"));

test("staff can charge a saved invoice securely before sharing a checkout link", () => fixture(async ({
  request, invoice, rows, addSharedInvoice, processorCalls
}) => {
  rows("invoiceresponses").clear();
  addSharedInvoice({ stage: "draft", paidAmount: 0 });
  const options = { staffCharge: true, publicToken: undefined };
  assert.equal((await request(options, "GET")).status, 401);
  const checkout = await request(options, "GET", true);
  assert.equal(checkout.body.amount, 125);
  assert.equal(checkout.body.tokenizationKey, "pk_syntheticPublic");
  assert.equal(rows("invoiceresponses").size, 0);
  assert.equal((await request({ ...options, cardNumber: "4111111111111111" }, "POST", true)).status, 400);

  const failed = request(options, "POST", true);
  await new Promise(resolve => setImmediate(resolve));
  processorCalls[0].respond({ status: "Declined", status_code: "D", cvv2_result_code: "N" });
  assert.equal((await failed).body.code, "security_code");
  const pending = request(options, "POST", true);
  await new Promise(resolve => setImmediate(resolve));
  processorCalls[1].respond({ status: "Approved", status_code: "A", reference_number: 83001, auth_amount: 125 });
  assert.equal((await pending).body.paidAmount, 125);
  const saved = rows("invoiceresponses").get(`${invoice.partitionKey}|${invoice.rowKey}`);
  assert.equal(saved.paymentRecordedBy, "staff@example.test");
  assert.equal(saved.publicToken, undefined);
  assert.equal((await request({}, "GET")).status, 404);
}, "paylynx"));

test("a settled return retains the selected fee and credits the net refund without reopening the invoice", () => fixture(async ({
  request, reverse, snapshot, processorCalls, addSharedInvoice, setChargeStatus
}) => {
  await confirmPaylynxCharge(request, processorCalls);
  addSharedInvoice();
  assert.equal((await reverse({}, false, "GET")).status, 401);
  setChargeStatus("settled");
  const preview = await reverse({}, true, "GET");
  assert.equal(preview.body.operation, "refund");
  assert.equal(preview.body.refundableAmount, 125);
  assert.equal((await reverse({ amount: "125.00", creditInvoice: true, retainedFee: 3, reason: "Return" })).status, 409);
  assert.equal((await reverse({ amount: "122.00", creditInvoice: true, retainedFee: 3 })).status, 400);
  const body = { amount: "122.00", creditInvoice: true, retainedFee: 3, reason: "Returned parts", expectedOperation: "refund" };
  const pending = reverse(body);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(processorCalls[1].payload, { reference_number: 83001, amount: 122 });
  processorCalls[1].respond({ status: "Approved", status_code: "A", reference_number: 93001 });
  const result = await pending;
  assert.equal(result.body.returnCreditAmount, 122);
  assert.equal((await reverse(body)).body.refundTransactionId, "93001");
  assert.equal(processorCalls.length, 2);
  assert.equal((await snapshot()).amount, "0");
  const [{ document }] = await listDocuments("shop-a");
  assert.equal(document.stage, "accepted");
  assert.equal(document.total, 3);
  assert.equal(document.paidAmount, 3);
  assert.equal(document.refundTransactions[0].retainedFee, 3);
}, "paylynx"));

for (const mode of ['test', 'live']) {
  test(`hosted PayLynx ${mode} mode charges and reverses using its original merchant mode`, () => fixture(async ({ request, rows, processorCalls, reverse, setChargeStatus }) => {
    const config = await request({}, 'GET');
    assert.equal(config.status, 200);
    assert.equal(config.body.mode, mode);
    assert.equal(config.body.sourceKey, undefined);
    const confirmed = await confirmPaylynxCharge(request, processorCalls);
    assert.equal(confirmed.body.mode, mode);
    assert.equal([...rows('paymentledger').values()][0].mode, mode);
    rows('appsettings').get('shop-a|billing.paymentProviders').valueJson = JSON.stringify({
      providers: [{ key: 'paylynx', connected: true, mode: mode === 'live' ? 'test' : 'live' }]
    });
    if (mode === 'live') setChargeStatus('settled');
    const input = mode === 'live'
      ? { amount: '24.00', alreadyReversed: 0, retainedFee: 1, creditInvoice: true, reason: 'Returned part' }
      : {};
    const pending = reverse(input);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(processorCalls[1].operation, mode === 'live' ? 'refund' : 'void');
    processorCalls[1].respond({ status: 'Approved', status_code: 'A', reference_number: 83002 });
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal(response.body.mode, mode);
    assert.equal(response.body.paidAmount, mode === 'live' ? 101 : 0);
    const saved = rows('invoiceresponses').get('shop-a|invoice-a');
    assert.equal(saved.amount, mode === 'live' ? '0.00' : '125.00');
    if (mode === 'live') assert.equal(JSON.parse(saved.reversalHistoryJson)[0].retainedFee, 1);
  }, 'paylynx', mode));
}

test('hosted gateway connection requires admin access and matching location credentials', () => fixture(async ({ configureGateway, rows }) => {
  const connected = await configureGateway('live');
  assert.equal(connected.status, 200);
  assert.doesNotMatch(JSON.stringify(connected.body), /synthetic-private/);
  assert.equal((await configureGateway('test')).status, 400);
  rows('useraccess').get('v1|staff@example.test').rolesJson = '["authenticated"]';
  assert.equal((await configureGateway('live')).status, 403);
  const { gatewayConfig } = require('../_shared/paylynx');
  assert.equal(gatewayConfig('another-location', 'live'), null);
}, 'paylynx', 'live'));

test('offline invoice payments preserve an unspecified processor mode', () => fixture(async ({ rows }) => {
  await invoiceResponse.recordInvoicePayment('shop-a', {
    invoiceId: 'invoice-a', paymentProvider: 'cash', paymentTransactionId: 'offline-receipt',
    paymentAmount: 125, paidAmount: 125, paymentKind: 'initial', invoiceNumber: 'INV-A'
  });
  assert.equal([...rows('paymentledger').values()][0].mode, '');
}));
