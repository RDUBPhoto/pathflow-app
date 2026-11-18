const { resolvePrincipal } = require("./auth");

function text(value) {
  return String(value ?? "").trim();
}

function flag(value) {
  return value === true || ["true", "1", "yes"].includes(text(value).toLowerCase());
}

function isActiveTenantUser(user, tenantId) {
  if (flag(user.disabled) || flag(user.revoked) || flag(user.accessRevoked)) return false;
  if ((text(user.status).toLowerCase() || "active") !== "active") return false;
  if (flag(user.allLocations) || flag(user.isSuperAdmin)) return true;
  let locations;
  try { locations = JSON.parse(user.locationIdsJson || "[]"); } catch { return false; }
  return Array.isArray(locations) && locations.some(id => text(id).toLowerCase() === tenantId);
}

function isIsolatedLocalRequest(req) {
  if (process.env.WEBSITE_SITE_NAME || process.env.PATHFLOW_ENVIRONMENT !== "development") return false;
  const host = Object.entries(req?.headers || {}).find(([name]) => name.toLowerCase() === "host")?.[1];
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(`http://${host}`).hostname);
  } catch { return false; }
}

async function resolveStaff(req, users, tenantId) {
  const actor = await resolvePrincipal(req, { allowSwa: false, allowDev: isIsolatedLocalRequest(req) });
  if (!actor) return { actor: null, authorized: false };
  if (actor.source === "dev") return { actor, authorized: true };
  for await (const user of users.listEntities({ queryOptions: { filter: "PartitionKey eq 'v1'" } })) {
    const matches = (actor.userId && text(user.userId || user.rowKey) === actor.userId) ||
      (actor.email && text(user.email).toLowerCase() === actor.email.toLowerCase());
    if (matches && isActiveTenantUser(user, tenantId)) return { actor, authorized: true };
  }
  return { actor, authorized: false };
}

module.exports = { resolveStaff, isActiveTenantUser };
