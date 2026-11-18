function asString(value) {
  return value == null ? "" : String(value).trim();
}

let ingestionCredential;
let ingestionClientId;

async function ingestionHeaders(credentialFactory, abortSignal) {
  const auth = parseConnectionString(process.env.APPLICATIONINSIGHTS_AUTHENTICATION_STRING);
  const headers = { 'content-type': 'application/json' };
  if (asString(auth.authorization).toUpperCase() !== 'AAD') return headers;
  const clientId = asString(auth.clientid);
  if (!ingestionCredential || ingestionClientId !== clientId || credentialFactory) {
    const create = credentialFactory || (id => {
      const { ManagedIdentityCredential } = require('@azure/identity');
      return id ? new ManagedIdentityCredential({ clientId: id }) : new ManagedIdentityCredential();
    });
    ingestionCredential = create(clientId);
    ingestionClientId = clientId;
  }
  const token = await ingestionCredential.getToken('https://monitor.azure.com/.default', { abortSignal });
  if (!token || !token.token) throw new Error('Telemetry identity did not return an access token.');
  headers.authorization = `Bearer ${token.token}`;
  return headers;
}

function parseConnectionString(value) {
  const out = {};
  for (const entry of asString(value).split(";")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = asString(entry.slice(0, separator)).toLowerCase();
    const resolved = asString(entry.slice(separator + 1));
    if (key && resolved) out[key] = resolved;
  }
  return out;
}

function applicationInsightsConfig() {
  const parsed = parseConnectionString(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING);
  const instrumentationKey = asString(parsed.instrumentationkey || process.env.APPINSIGHTS_INSTRUMENTATIONKEY);
  if (!instrumentationKey) return null;
  const ingestionEndpoint = asString(parsed.ingestionendpoint || "https://dc.services.visualstudio.com").replace(/\/+$/, "");
  return {
    instrumentationKey,
    trackUrl: `${ingestionEndpoint}/v2/track`
  };
}

function applicationInsightsEnvelope(config, payload) {
  const properties = Object.fromEntries(
    Object.entries(payload.properties || {}).map(([key, value]) => [key, String(value)])
  );
  return {
    name: "Microsoft.ApplicationInsights.Event",
    time: asString(payload.timestamp) || new Date().toISOString(),
    iKey: config.instrumentationKey,
    tags: {
      "ai.cloud.role": process.env.WEBSITE_SITE_NAME || "pathflow-swa-api"
    },
    data: {
      baseType: "EventData",
      baseData: {
        ver: 2,
        name: asString(payload.event) || "pathflow.client.timing",
        properties: {
          ...properties,
          pagePath: asString(payload.pagePath)
        },
        measurements: payload.measurements || {}
      }
    }
  };
}

async function exportToApplicationInsights(payload) {
  const config = applicationInsightsConfig();
  if (!config || typeof fetch !== "function") return false;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(config.trackUrl, {
      method: "POST",
      headers: await ingestionHeaders(undefined, controller.signal),
      body: JSON.stringify(applicationInsightsEnvelope(config, payload)),
      signal: controller.signal
    });
    return response.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function trackClientTiming(context, payload) {
  context.log("PathFlow client timing", {
    event: asString(payload && payload.event),
    pagePath: asString(payload && payload.pagePath),
    properties: payload && payload.properties || {},
    measurements: payload && payload.measurements || {}
  });
  return exportToApplicationInsights(payload || {});
}

module.exports = {
  ingestionHeaders,
  applicationInsightsConfig,
  applicationInsightsEnvelope,
  exportToApplicationInsights,
  parseConnectionString,
  trackClientTiming
};
