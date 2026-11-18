const { trackClientTiming } = require("../_shared/telemetry");

const ALLOWED_EVENTS = new Set([
  "auth.bootstrap",
  "auth.config.request",
  "auth.state.request",
  "login.biometric_prompt.visible"
]);

const ALLOWED_PROPERTIES = new Set([
  "authenticated",
  "authLoading",
  "cached",
  "mode",
  "outcome",
  "status"
]);

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function safeProperties(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (!ALLOWED_PROPERTIES.has(key)) continue;
    if (!["string", "number", "boolean"].includes(typeof value)) continue;
    out[key] = typeof value === "string" ? value.slice(0, 80) : value;
  }
  return out;
}

function safeMeasurements(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (!/^[a-z][a-z0-9._-]{0,48}$/i.test(key)) continue;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) continue;
    out[key] = Math.min(numeric, 120000);
  }
  return out;
}

module.exports = async function (context, req) {
  const method = asString(req && req.method).toUpperCase();
  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }
  if (method !== "POST") {
    context.res = { status: 405, body: { ok: false, error: "Method not allowed." } };
    return;
  }

  const body = req && req.body && typeof req.body === "object" ? req.body : {};
  const event = asString(body.event).toLowerCase();
  if (!ALLOWED_EVENTS.has(event)) {
    context.res = { status: 400, body: { ok: false, error: "Unsupported telemetry event." } };
    return;
  }

  const payload = {
    event,
    timestamp: asString(body.timestamp).slice(0, 40),
    pagePath: asString(body.pagePath).split("?")[0].slice(0, 120),
    properties: safeProperties(body.properties),
    measurements: safeMeasurements(body.measurements)
  };
  const exported = await trackClientTiming(context, payload);
  context.res = {
    status: 202,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8"
    },
    body: { ok: true, exported }
  };
};
