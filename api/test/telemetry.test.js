const test = require("node:test");
const assert = require("node:assert/strict");

const telemetryHandler = require("../telemetry");
const { applicationInsightsEnvelope, parseConnectionString } = require("../_shared/telemetry");
const { ingestionHeaders } = require("../_shared/telemetry");

test('AAD-only telemetry uses the configured managed identity for ingestion', async () => {
  const previous = process.env.APPLICATIONINSIGHTS_AUTHENTICATION_STRING;
  process.env.APPLICATIONINSIGHTS_AUTHENTICATION_STRING = 'ClientId=test-client;Authorization=AAD';
  try {
    const headers = await ingestionHeaders(clientId => {
      assert.equal(clientId, 'test-client');
      return { getToken: async scope => {
        assert.equal(scope, 'https://monitor.azure.com/.default');
        return { token: 'fake-test-token' };
      } };
    });
    assert.equal(headers.authorization, 'Bearer fake-test-token');
  } finally {
    if (previous === undefined) delete process.env.APPLICATIONINSIGHTS_AUTHENTICATION_STRING;
    else process.env.APPLICATIONINSIGHTS_AUTHENTICATION_STRING = previous;
  }
});

function createContext() {
  const entries = [];
  return {
    entries,
    log: (...args) => entries.push(args),
    res: null
  };
}

test("telemetry accepts allowlisted timing data and strips unknown properties", async () => {
  const context = createContext();
  await telemetryHandler(context, {
    method: "POST",
    body: {
      event: "auth.bootstrap",
      timestamp: "2026-10-08T00:00:00.000Z",
      pagePath: "/login?email=private@example.com",
      properties: {
        mode: "remote",
        outcome: "ok",
        email: "private@example.com"
      },
      measurements: {
        durationMs: 321.5,
        invalid: -1
      }
    }
  });

  assert.equal(context.res.status, 202);
  assert.equal(context.res.body.ok, true);
  assert.equal(context.entries.length, 1);
  const logged = context.entries[0][1];
  assert.equal(logged.pagePath, "/login");
  assert.deepEqual(logged.properties, { mode: "remote", outcome: "ok" });
  assert.deepEqual(logged.measurements, { durationMs: 321.5 });
  assert.equal(JSON.stringify(logged).includes("private@example.com"), false);
});

test("telemetry rejects arbitrary event names", async () => {
  const context = createContext();
  await telemetryHandler(context, {
    method: "POST",
    body: { event: "user.supplied.event" }
  });

  assert.equal(context.res.status, 400);
  assert.equal(context.entries.length, 0);
});

test("Application Insights export builds a valid custom-event envelope", () => {
  const parsed = parseConnectionString("InstrumentationKey=test-key;IngestionEndpoint=https://example.test/");
  assert.deepEqual(parsed, {
    instrumentationkey: "test-key",
    ingestionendpoint: "https://example.test/"
  });

  const envelope = applicationInsightsEnvelope(
    { instrumentationKey: "test-key" },
    {
      event: "auth.bootstrap",
      timestamp: "2026-10-08T00:00:00.000Z",
      pagePath: "/login",
      properties: { mode: "remote" },
      measurements: { durationMs: 100 }
    }
  );

  assert.equal(envelope.name, "Microsoft.ApplicationInsights.Event");
  assert.equal(envelope.iKey, "test-key");
  assert.equal(envelope.data.baseType, "EventData");
  assert.equal(envelope.data.baseData.name, "auth.bootstrap");
  assert.equal(envelope.data.baseData.properties.pagePath, "/login");
  assert.equal(envelope.data.baseData.measurements.durationMs, 100);
});
