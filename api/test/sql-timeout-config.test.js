const test = require("node:test");
const assert = require("node:assert/strict");
const { _internals } = require("../_shared/table-client");

test("SQL connection strings receive a request timeout longer than the driver's 15-second default", () => {
  const previousRequest = process.env.SQL_REQUEST_TIMEOUT_MS;
  const previousConnection = process.env.SQL_CONNECTION_TIMEOUT_MS;
  delete process.env.SQL_REQUEST_TIMEOUT_MS;
  delete process.env.SQL_CONNECTION_TIMEOUT_MS;
  try {
    const config = _internals.normalizeSqlPoolConfig(
      "Server=localhost;Database=pathflow_test;User Id=test;Password=not-a-real-password;Connection Timeout=30;"
    );
    assert.equal(config.requestTimeout, 30000);
    assert.equal(config.connectionTimeout, 30000);
    assert.equal(config.database, "pathflow_test");
  } finally {
    if (previousRequest === undefined) delete process.env.SQL_REQUEST_TIMEOUT_MS;
    else process.env.SQL_REQUEST_TIMEOUT_MS = previousRequest;
    if (previousConnection === undefined) delete process.env.SQL_CONNECTION_TIMEOUT_MS;
    else process.env.SQL_CONNECTION_TIMEOUT_MS = previousConnection;
  }
});

test("an explicit SQL request timeout is preserved", () => {
  const previous = process.env.SQL_REQUEST_TIMEOUT_MS;
  delete process.env.SQL_REQUEST_TIMEOUT_MS;
  try {
    const config = _internals.normalizeSqlPoolConfig(
      "Server=localhost;Database=pathflow_test;User Id=test;Password=not-a-real-password;Request Timeout=45000;"
    );
    assert.equal(config.requestTimeout, 45000);
  } finally {
    if (previous === undefined) delete process.env.SQL_REQUEST_TIMEOUT_MS;
    else process.env.SQL_REQUEST_TIMEOUT_MS = previous;
  }
});
