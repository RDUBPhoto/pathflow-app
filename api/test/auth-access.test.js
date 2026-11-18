const test = require("node:test");
const assert = require("node:assert/strict");
const { TableClient } = require("../_shared/table-client");
const { hashPassword, requirePrincipal } = require("../_shared/auth");
const { issuePasswordReset } = require("../_shared/password-reset");
const access = require("../access");

async function fixture(run) {
  const environment = {
    STORAGE_CONNECTION_STRING: "UseDevelopmentStorage=true", DATA_BACKEND: "table",
    WEBSITE_SITE_NAME: "production-fixture", PATHFLOW_ENVIRONMENT: "production", NODE_ENV: "production",
    EMAIL_MODE: "mock", APP_BASE_URL: "https://app.example.test", AUTH_PRIMARY_PROVIDER: "local",
    AUTH_LOCAL_PASSWORD_ENABLED: "true", SUBSCRIPTION_BILLING_ENABLED: "false"
  };
  const before = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const original = TableClient.fromConnectionString;
  const tables = new Map();
  const rows = name => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name);
  };
  const put = (name, entity) => rows(name).set(entity.partitionKey + "|" + entity.rowKey, { ...entity });
  const client = name => ({
    async createTable() {},
    async getEntity(pk, rk) {
      const value = rows(name).get(pk + "|" + rk);
      if (!value) throw Object.assign(new Error("Missing"), { statusCode: 404 });
      return { ...value };
    },
    async createEntity(entity) { put(name, entity); },
    async upsertEntity(entity) {
      put(name, { ...rows(name).get(entity.partitionKey + "|" + entity.rowKey), ...entity });
    },
    async replaceIfRevision(entity, revision) {
      if (rows(name).get(entity.partitionKey + "|" + entity.rowKey)?.revision !== revision) return false;
      put(name, entity);
      return true;
    },
    async deleteEntity(pk, rk) { rows(name).delete(pk + "|" + rk); },
    async *listEntities(options) {
      const email = options?.queryOptions?.filter?.match(/email eq '([^']+)'/)?.[1];
      for (const row of rows(name).values()) if (!email || row.email === email) yield { ...row };
    }
  });
  TableClient.fromConnectionString = (_connection, name) => client(name);
  const log = Object.assign(() => {}, { error() {}, warn() {} });
  async function request(method, body, headers = {}, query = {}) {
    const context = { log };
    await access(context, { method, body, query, headers: { host: "app.example.test", ...headers } });
    return context.res;
  }
  try { await run({ request, put, rows, client, log }); }
  finally {
    TableClient.fromConnectionString = original;
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("password login establishes a secure session and profile checks do not clear a new login", () => fixture(async ({ request, put }) => {
  const password = hashPassword("FixturePassword-123");
  put("authlocalaccounts", { partitionKey: "v1", rowKey: "staff@example.test", passwordHash: password.hash,
    passwordSalt: password.salt, passwordIterations: password.iterations });
  const login = await request("POST", { op: "password-login", email: "staff@example.test", password: "FixturePassword-123" });
  assert.equal(login.status, 200);
  assert.match(login.headers["set-cookie"], /pf_session=.+; Path=.+Secure/);
  const cookie = login.headers["set-cookie"].split(";")[0];
  const profile = await request("GET", null, { cookie }, { scope: "me" });
  assert.equal(profile.body.principal.email, "staff@example.test");
  assert.equal(profile.headers["set-cookie"], undefined);
  const anonymous = await request("GET", null, {}, { scope: "me" });
  assert.equal(anonymous.body.principal, null);
  assert.equal(anonymous.headers["set-cookie"], undefined);
}));

test("profile-store failure returns an error without clearing a valid cookie", () => fixture(async ({ request, put }) => {
  const { createHash } = require("node:crypto");
  put("authsessions", { partitionKey: "v1", rowKey: createHash("sha256").update("saved").digest("hex"),
    email: "staff@example.test", expiresAt: new Date(Date.now() + 60000).toISOString() });
  const original = TableClient.fromConnectionString;
  TableClient.fromConnectionString = (connection, name) => name === "useraccess"
    ? { async createTable() {}, async getEntity() { throw new Error("private SQL details"); } }
    : original(connection, name);
  const response = await request("GET", null, { cookie: "pf_session=saved" }, { scope: "me" });
  assert.ok(response.status >= 500);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.doesNotMatch(JSON.stringify(response.body), /private SQL details/);
}));

test("single-use reset updates the password, activates the invite, and revokes previous sessions", () => fixture(async ({ request, put, client, rows }) => {
  const email = "invited@example.test";
  put("useraccess", { partitionKey: "v1", rowKey: email, email, status: "invited",
    locationIdsJson: '["tenant-a"]', defaultLocationId: "tenant-a" });
  put("authsessions", { partitionKey: "v1", rowKey: "old-session", email });
  const token = await issuePasswordReset(client("authpasswordresets"), email);
  const reset = await request("POST", { op: "reset-password", token, password: "NewPassword-123" });
  assert.equal(reset.status, 200);
  assert.equal(rows("authsessions").size, 0);
  assert.equal(rows("useraccess").get("v1|" + email).status, "active");
  const replay = await request("POST", { op: "reset-password", token, password: "WrongPassword-123" });
  assert.equal(replay.status, 400);
  const login = await request("POST", { op: "password-login", email, password: "NewPassword-123" });
  assert.equal(login.status, 200);
}));

test("reset tokens expire and concurrent consumption cannot reset twice", () => fixture(async ({ request, client, rows, put }) => {
  put("authlocalaccounts", { partitionKey: "v1", rowKey: "staff@example.test", email: "staff@example.test" });
  const token = await issuePasswordReset(client("authpasswordresets"), "staff@example.test");
  const record = [...rows("authpasswordresets").values()][0];
  assert.doesNotMatch(JSON.stringify(record), new RegExp(token));
  record.expiresAt = "2000-01-01T00:00:00Z";
  assert.equal((await request("POST", { op: "reset-password", token, password: "NewPassword-123" })).status, 400);
  const fresh = await issuePasswordReset(client("authpasswordresets"), "staff@example.test");
  const responses = await Promise.all([1, 2].map(() => request("POST", {
    op: "reset-password", token: fresh, password: "NewPassword-123"
  })));
  assert.deepEqual(responses.map(result => result.status).sort(), [200, 400]);
}));

test("signup cannot claim an existing staff email without mailbox verification", () => fixture(async ({ request, put, rows }) => {
  put("useraccess", { partitionKey: "v1", rowKey: "existing@example.test", email: "existing@example.test", status: "invited" });
  const response = await request("POST", {
    op: "password-signup", email: "existing@example.test", password: "SyntheticPassword-123", displayName: "Pretender", phone: "5125550100"
  });
  assert.equal(response.status, 409);
  assert.equal(rows("authlocalaccounts").size, 0);
}));

test("protected data checks tenant membership and rejects forged development identity", () => fixture(async ({ put }) => {
  const { createHash } = require("node:crypto");
  put("authsessions", { partitionKey: "v1", rowKey: createHash("sha256").update("saved").digest("hex"),
    email: "staff@example.test", expiresAt: new Date(Date.now() + 60000).toISOString() });
  put("useraccess", { partitionKey: "v1", rowKey: "staff@example.test", status: "active", locationIdsJson: '["tenant-a"]' });
  const allowed = {};
  assert.ok(await requirePrincipal(allowed, { headers: { cookie: "pf_session=saved", "x-tenant-id": "tenant-a" } }));
  const denied = {};
  assert.equal(await requirePrincipal(denied, { headers: { cookie: "pf_session=saved", "x-tenant-id": "tenant-b" } }), null);
  assert.equal(denied.res.status, 403);
  const spoofed = {};
  assert.equal(await requirePrincipal(spoofed, { headers: { host: "localhost:7071", "x-dev-user-email": "staff@example.test" } }), null);
  assert.equal(spoofed.res.status, 401);
}));

test("federated profile bootstrap supplies the app cookie needed by protected staff endpoints", () => fixture(async ({ request, put }) => {
  put("useraccess", { partitionKey: "v1", rowKey: "staff@example.test", email: "staff@example.test",
    status: "active", locationIdsJson: '["tenant-a"]', defaultLocationId: "tenant-a" });
  const principal = Buffer.from(JSON.stringify({ userId: "staff", userDetails: "staff@example.test",
    identityProvider: "aad", userRoles: ["authenticated"] })).toString("base64");
  const response = await request("GET", null, { "x-ms-client-principal": principal }, { scope: "me" });
  assert.equal(response.status, 200);
  assert.match(response.headers["set-cookie"], /pf_session=/);
}));

test("subscription billing cannot activate a hosted workspace from entered card details", () => fixture(async ({ request, put, rows }) => {
  process.env.SUBSCRIPTION_BILLING_ENABLED = "true";
  const email = "staff@example.test";
  const principal = Buffer.from(JSON.stringify({ userId: "staff", userDetails: email,
    identityProvider: "aad", userRoles: ["authenticated"] })).toString("base64");
  const headers = { "x-ms-client-principal": principal };
  put("useraccess", { partitionKey: "v1", rowKey: email, email, status: "active",
    locationIdsJson: '["tenant-a"]', defaultLocationId: "tenant-a" });
  put("tenants", { partitionKey: "v1", rowKey: "tenant-a", name: "Expired Shop",
    billingStatus: "pending", trialEndsAt: "2000-01-01T00:00:00Z" });
  const profile = await request("GET", null, headers, { scope: "me" });
  assert.equal(profile.body.profile.billingStatus, "pending");
  assert.equal(profile.body.profile.accessLocked, true);
  for (const cardNumber of ["9999999999999999", "4111111111111111"]) {
    const response = await request("POST", { op: "update-billing", locationId: "tenant-a",
      billing: { cardNumber } }, headers);
    assert.equal(response.status, 503);
    assert.match(response.body.error, /subscription billing is being configured/);
    assert.equal(rows("tenants").get("v1|tenant-a").billingStatus, "pending");
  }
  rows("tenants").get("v1|tenant-a").billingStatus = "sandbox";
  assert.equal((await request("GET", null, headers, { scope: "me" })).body.profile.accessLocked, true);
}));

test("protected endpoints use current membership roles after an admin is demoted", () => fixture(async ({ put }) => {
  const { createHash } = require("node:crypto");
  put("authsessions", { partitionKey: "v1", rowKey: createHash("sha256").update("saved").digest("hex"),
    email: "staff@example.test", rolesJson: '["authenticated","admin"]',
    expiresAt: new Date(Date.now() + 60000).toISOString() });
  put("useraccess", { partitionKey: "v1", rowKey: "staff@example.test", status: "active",
    locationIdsJson: '["tenant-a"]', rolesJson: '["authenticated"]' });
  const principal = await requirePrincipal({}, {
    headers: { cookie: "pf_session=saved", "x-tenant-id": "tenant-a" }
  });
  assert.deepEqual(principal.userRoles, ["authenticated"]);
}));

test('complimentary access survives an expired trial while revoked users remain locked', () => fixture(async ({ request, put, rows }) => {
  const email = 'staff@example.test';
  const principal = Buffer.from(JSON.stringify({ userId: 'staff', userDetails: email,
    identityProvider: 'aad', userRoles: ['authenticated'] })).toString('base64');
  const headers = { 'x-ms-client-principal': principal };
  put('useraccess', { partitionKey: 'v1', rowKey: email, email, status: 'active',
    locationIdsJson: '["tenant-a"]', defaultLocationId: 'tenant-a' });
  put('tenants', { partitionKey: 'v1', rowKey: 'tenant-a', name: 'Existing Shop',
    billingStatus: 'trial', trialEndsAt: '2000-01-01T00:00:00Z' });
  const profile = await request('GET', null, headers, { scope: 'me' });
  assert.equal(profile.body.profile.billingStatus, 'complimentary');
  assert.equal(profile.body.profile.accessLocked, false);
  assert.equal(profile.body.profile.trialEndsAt, '');
  rows('useraccess').get('v1|' + email).accessRevoked = true;
  assert.equal((await request('GET', null, headers, { scope: 'me' })).body.profile.accessLocked, true);
}));
