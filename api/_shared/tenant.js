function asString(value) {
  return value == null ? "" : String(value).trim();
}

function sanitizeTenantId(value) {
  const cleaned = asString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || "tenant-unassigned";
}

function readHeader(headers, key) {
  if (!headers || typeof headers !== "object") return "";
  const direct = headers[key];
  if (direct != null) return asString(direct);
  const lowerKey = key.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (String(name || "").toLowerCase() !== lowerKey) continue;
    return asString(value);
  }
  return "";
}

function resolveTenantId(req, body) {
  const headerTenant = readHeader(req && req.headers, "x-tenant-id");
  const queryTenant = asString(req && req.query && req.query.tenantId);
  const bodyTenant = asString(body && body.tenantId);
  const fallback = asString(process.env.DEFAULT_TENANT_ID) || "primary-location";
  return sanitizeTenantId(headerTenant || queryTenant || bodyTenant || fallback);
}

module.exports = {
  resolveTenantId,
  sanitizeTenantId
};
