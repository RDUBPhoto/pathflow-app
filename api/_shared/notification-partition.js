const { sanitizeTenantId } = require("./tenant");

const TENANT_SCOPE_DELIMITER = "::";

function scopedTenantPartition(tenantId) {
  const namespace = sanitizeTenantId(process.env.NOTIFICATIONS_NAMESPACE || process.env.APP_ENV || process.env.NODE_ENV);
  const hostname = String(process.env.WEBSITE_HOSTNAME || "").toLowerCase();
  const scope = namespace !== "tenant-unassigned"
    ? namespace
    : (!hostname || hostname.includes("localhost") || hostname.includes("127.0.0.1") ? "local" : "prod");
  return `${sanitizeTenantId(tenantId || "main")}${TENANT_SCOPE_DELIMITER}${scope}`;
}

module.exports = { scopedTenantPartition, TENANT_SCOPE_DELIMITER };
