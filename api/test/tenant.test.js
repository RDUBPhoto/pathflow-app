const test = require("node:test");
const assert = require("node:assert/strict");

const { sanitizeTenantId, resolveTenantId } = require("../_shared/tenant");

test("sanitizeTenantId normalizes valid input", () => {
  assert.equal(sanitizeTenantId("Exodus 4x4"), "exodus-4x4");
  assert.equal(sanitizeTenantId("pathflow-app::prod"), "pathflow-app::prod");
});

test("sanitizeTenantId falls back when input is empty", () => {
  assert.equal(sanitizeTenantId(""), "tenant-unassigned");
  assert.equal(sanitizeTenantId(null), "tenant-unassigned");
});

test("resolveTenantId uses precedence header > query > body > env > fallback", () => {
  const req = {
    headers: { "x-tenant-id": "Header Tenant" },
    query: { tenantId: "query-tenant" }
  };
  const body = { tenantId: "body-tenant" };
  assert.equal(resolveTenantId(req, body), "header-tenant");
});

test("resolveTenantId falls back to DEFAULT_TENANT_ID when request does not include tenant", () => {
  const original = process.env.DEFAULT_TENANT_ID;
  process.env.DEFAULT_TENANT_ID = "Env Tenant";
  assert.equal(resolveTenantId({ headers: {}, query: {} }, {}), "env-tenant");
  if (original === undefined) delete process.env.DEFAULT_TENANT_ID;
  else process.env.DEFAULT_TENANT_ID = original;
});

test("resolveTenantId falls back to tenant-unassigned when nothing is set", () => {
  const original = process.env.DEFAULT_TENANT_ID;
  delete process.env.DEFAULT_TENANT_ID;
  assert.equal(resolveTenantId({ headers: {}, query: {} }, {}), "tenant-unassigned");
  if (original !== undefined) process.env.DEFAULT_TENANT_ID = original;
});
