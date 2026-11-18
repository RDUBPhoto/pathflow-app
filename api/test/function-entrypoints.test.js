const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("every Azure Function entrypoint loads without a module error", () => {
  const apiRoot = path.resolve(__dirname, "..");
  const functionDirectories = fs.readdirSync(apiRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry => fs.existsSync(path.join(apiRoot, entry.name, "function.json")))
    .map(entry => entry.name)
    .sort();

  assert.ok(functionDirectories.length > 0, "Expected at least one Azure Function directory");

  const failures = [];
  for (const functionName of functionDirectories) {
    const entrypoint = path.join(apiRoot, functionName, "index.js");
    if (!fs.existsSync(entrypoint)) {
      failures.push(`${functionName}: missing index.js`);
      continue;
    }
    try {
      require(entrypoint);
    } catch (error) {
      failures.push(`${functionName}: ${String(error && error.message || error)}`);
    }
  }

  assert.deepEqual(failures, [], failures.join("\n"));
});
