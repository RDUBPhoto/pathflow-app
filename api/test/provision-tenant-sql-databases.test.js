const test = require("node:test");
const assert = require("node:assert/strict");

const { parseArgs } = require("../scripts/provision-tenant-sql-databases");

test("parseArgs default values", () => {
  const parsed = parseArgs([]);
  assert.deepEqual(parsed, {
    cleanup: false,
    dryRun: false,
    tenantIds: []
  });
});

test("parseArgs supports dry-run, cleanup, and tenant list", () => {
  const parsed = parseArgs(["--dry-run", "--cleanup", "--tenant", "Exodus 4x4", "-t", "pathflow-app"]);
  assert.deepEqual(parsed, {
    cleanup: true,
    dryRun: true,
    tenantIds: ["exodus-4x4", "pathflow-app"]
  });
});

test("parseArgs deduplicates tenants and ignores empty tenant values", () => {
  const parsed = parseArgs(["--tenant", "", "--tenant", "pathflow-app", "--tenant", "pathflow-app"]);
  assert.deepEqual(parsed, {
    cleanup: false,
    dryRun: false,
    tenantIds: ["pathflow-app"]
  });
});
