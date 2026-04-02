const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function readApiFile(relativePath) {
  const fullPath = path.resolve(__dirname, "..", relativePath);
  return fs.readFileSync(fullPath, "utf8");
}

test("tenant-scoped APIs do not use legacy main partition constants", () => {
  const targets = [
    "inventory/index.js",
    "purchase-orders/index.js",
    "email/index.js",
    "reports/index.js",
    "widget-lead/index.js"
  ];

  for (const file of targets) {
    const source = readApiFile(file);
    assert.equal(source.includes('PARTITION = "main"'), false, `${file} still defines PARTITION=main`);
    assert.equal(source.includes("partitionKey: PARTITION"), false, `${file} still writes partitionKey: PARTITION`);
    assert.equal(source.includes("getEntity(PARTITION"), false, `${file} still reads using PARTITION`);
    assert.equal(source.includes("deleteEntity(PARTITION"), false, `${file} still deletes using PARTITION`);
    assert.equal(source.includes("PartitionKey eq '${PARTITION}'"), false, `${file} still filters using PARTITION`);
  }
});

test("tenant-scoped APIs resolve tenant id from requests", () => {
  const targets = [
    "inventory/index.js",
    "purchase-orders/index.js",
    "email/index.js",
    "reports/index.js",
    "widget-lead/index.js"
  ];

  for (const file of targets) {
    const source = readApiFile(file);
    assert.equal(
      source.includes("resolveTenantId("),
      true,
      `${file} should resolve tenantId from request`
    );
  }
});

test("lanes-delete has no legacy main partition constant", () => {
  const source = readApiFile("lanes-delete/index.js");
  assert.equal(source.includes('PARTITION = "main"'), false, "lanes-delete should not define PARTITION=main");
});
