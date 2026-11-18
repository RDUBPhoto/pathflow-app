const test = require("node:test");
const assert = require("node:assert/strict");

const { resolvePrincipal } = require("../_shared/auth");

test("anonymous principal resolution does not initialize session storage", async () => {
  let factoryCalls = 0;
  const principal = await resolvePrincipal(
    { headers: {} },
    {
      allowSwa: false,
      allowDev: false,
      sessionClientFactory: async () => {
        factoryCalls += 1;
        throw new Error("session storage should not be initialized");
      }
    }
  );

  assert.equal(principal, null);
  assert.equal(factoryCalls, 0);
});

test("session storage is initialized when a session cookie is present", async () => {
  let factoryCalls = 0;
  const principal = await resolvePrincipal(
    { headers: { cookie: "pf_session=test-token" } },
    {
      allowSwa: false,
      allowDev: false,
      sessionClientFactory: async () => {
        factoryCalls += 1;
        return {
          getEntity: async () => {
            throw Object.assign(new Error("not found"), { statusCode: 404 });
          }
        };
      }
    }
  );

  assert.equal(principal, null);
  assert.equal(factoryCalls, 1);
});

test("storage failures preserve the distinction between unavailable and invalid sessions", async () => {
  const { SessionStorageUnavailableError } = require("../_shared/auth");
  await assert.rejects(resolvePrincipal({ headers: { cookie: "pf_session=saved" } }, {
    sessionClient: { async getEntity() { throw new Error("temporary SQL timeout"); } }
  }), SessionStorageUnavailableError);
});

test("unrelated malformed cookies cannot prevent a valid session lookup", async () => {
  const principal = await resolvePrincipal({ headers: { cookie: "other=%E0%A4%A; pf_session=valid" } }, {
    allowSwa: false, allowDev: false,
    sessionClient: {
      async getEntity() { return { email: "staff@example.test", expiresAt: new Date(Date.now() + 60000).toISOString() }; },
      async upsertEntity() { throw new Error("Session reads must not write or resurrect a deleted session."); }
    }
  });
  assert.equal(principal.email, "staff@example.test");
});

test("development identity is disabled in a hosted runtime even with localhost headers", async () => {
  const before = process.env.WEBSITE_SITE_NAME;
  process.env.WEBSITE_SITE_NAME = "hosted-auth-test";
  try {
    const principal = await resolvePrincipal({ headers: { host: "localhost:7071",
      "x-forwarded-host": "localhost:7071", "x-dev-user-email": "admin@example.test" } }, { allowSwa: false });
    assert.equal(principal, null);
  } finally {
    if (before === undefined) delete process.env.WEBSITE_SITE_NAME;
    else process.env.WEBSITE_SITE_NAME = before;
  }
});

test("hosted cookies retain Secure, HttpOnly and SameSite protections", () => {
  const { createSessionCookie } = require("../_shared/auth");
  const before = process.env.WEBSITE_SITE_NAME;
  process.env.WEBSITE_SITE_NAME = "hosted-auth-test";
  try {
    assert.match(createSessionCookie("synthetic"), /; Secure$/);
    assert.match(createSessionCookie("synthetic"), /; HttpOnly;/);
    assert.match(createSessionCookie("synthetic"), /; SameSite=Lax/);
  } finally {
    if (before === undefined) delete process.env.WEBSITE_SITE_NAME;
    else process.env.WEBSITE_SITE_NAME = before;
  }
});
