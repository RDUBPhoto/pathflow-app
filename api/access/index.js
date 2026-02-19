const { TableClient } = require("@azure/data-tables");
const { sanitizeTenantId } = require("../_shared/tenant");

const USERS_TABLE = "useraccess";
const TENANTS_TABLE = "tenants";
const USERS_PARTITION = "v1";
const TENANTS_PARTITION = "v1";

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return {};
}

function asBool(value) {
  if (typeof value === "boolean") return value;
  const lowered = asString(value).toLowerCase();
  return lowered === "true" || lowered === "1" || lowered === "yes";
}

function parseJson(value, fallback) {
  const raw = asString(value);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function readHeader(headers, key) {
  if (!headers || typeof headers !== "object") return "";
  const direct = headers[key];
  if (direct != null) return asString(direct);
  const normalized = key.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (String(name || "").toLowerCase() !== normalized) continue;
    return asString(value);
  }
  return "";
}

function escapedFilterValue(value) {
  return asString(value).replace(/'/g, "''");
}

function normalizeEmail(value) {
  return asString(value).toLowerCase();
}

function normalizeRole(value) {
  return asString(value).toLowerCase();
}

function normalizeRoleList(values) {
  const out = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeRole(value);
    if (!normalized) continue;
    out.add(normalized);
  }
  if (!out.has("authenticated")) out.add("authenticated");
  return Array.from(out);
}

function humanizeTenantId(tenantId) {
  const value = asString(tenantId).replace(/[-_]+/g, " ").trim();
  if (!value) return "Location";
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parsePrincipal(req) {
  const encoded = readHeader(req && req.headers, "x-ms-client-principal");
  if (!encoded) return null;

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const raw = parseJson(decoded, {});
    const claims = Array.isArray(raw.claims) ? raw.claims : [];

    const claimEmail = claims.find(item => asString(item && item.typ).toLowerCase() === "emails")?.val ||
      claims.find(item => asString(item && item.typ).toLowerCase() === "email")?.val ||
      claims.find(item => asString(item && item.typ).toLowerCase() === "preferred_username")?.val;

    const userDetails = asString(raw.userDetails);
    const email = normalizeEmail(claimEmail || (userDetails.includes("@") ? userDetails : ""));

    if (!email) return null;

    return {
      userId: asString(raw.userId || email),
      email,
      displayName: userDetails || email,
      identityProvider: asString(raw.identityProvider || "unknown"),
      userRoles: normalizeRoleList(raw.userRoles || [])
    };
  } catch {
    return null;
  }
}

async function getTableClient(connectionString, tableName) {
  const client = TableClient.fromConnectionString(connectionString, tableName);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

async function listTenants(tenantClient) {
  const out = [];
  const filter = `PartitionKey eq '${escapedFilterValue(TENANTS_PARTITION)}'`;
  const iter = tenantClient.listEntities({ queryOptions: { filter } });
  for await (const entity of iter) {
    const id = sanitizeTenantId(asString(entity.rowKey));
    if (!id) continue;
    const name = asString(entity.name) || humanizeTenantId(id);
    out.push({ id, name });
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));
  return out;
}

async function getUserEntity(userClient, email) {
  const rowKey = normalizeEmail(email);
  if (!rowKey) return null;
  try {
    return await userClient.getEntity(USERS_PARTITION, rowKey);
  } catch {
    return null;
  }
}

async function anyUsersExist(userClient) {
  const filter = `PartitionKey eq '${escapedFilterValue(USERS_PARTITION)}'`;
  const iter = userClient.listEntities({ queryOptions: { filter } });
  for await (const _entity of iter) {
    return true;
  }
  return false;
}

function parseUserLocationIds(userEntity) {
  const parsed = parseJson(userEntity && userEntity.locationIdsJson, []);
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(parsed) ? parsed : []) {
    const id = sanitizeTenantId(asString(value));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function parseUserRoles(userEntity) {
  const parsed = parseJson(userEntity && userEntity.rolesJson, []);
  return normalizeRoleList(Array.isArray(parsed) ? parsed : []);
}

function buildUserLocations(userEntity, tenants) {
  const tenantList = Array.isArray(tenants) ? tenants : [];
  const allLocations = asBool(userEntity && userEntity.allLocations);
  const allowedIds = parseUserLocationIds(userEntity);

  if (allLocations || !allowedIds.length) {
    return [...tenantList];
  }

  const byId = new Map(tenantList.map(item => [item.id, item]));
  return allowedIds.map(id => byId.get(id) || { id, name: humanizeTenantId(id) });
}

function pickDefaultLocation(userEntity, locations) {
  const normalized = sanitizeTenantId(asString(userEntity && userEntity.defaultLocationId));
  if (normalized && locations.some(item => item.id === normalized)) return normalized;
  return locations[0]?.id || "";
}

function buildMeResponse(principal, userEntity, allTenants, canBootstrap) {
  if (!userEntity) {
    return {
      ok: true,
      canBootstrap: !!canBootstrap,
      profile: null,
      locations: allTenants,
      principal: {
        userId: asString(principal && principal.userId),
        email: asString(principal && principal.email),
        displayName: asString(principal && principal.displayName),
        identityProvider: asString(principal && principal.identityProvider)
      }
    };
  }

  const roles = parseUserRoles(userEntity);
  const locations = buildUserLocations(userEntity, allTenants);
  const defaultLocationId = pickDefaultLocation(userEntity, locations);

  return {
    ok: true,
    canBootstrap: !!canBootstrap,
    profile: {
      email: normalizeEmail(userEntity.email || principal.email),
      displayName: asString(userEntity.displayName || principal.displayName || principal.email),
      isSuperAdmin: asBool(userEntity.isSuperAdmin),
      roles,
      defaultLocationId,
      locations
    },
    locations: allTenants,
    principal: {
      userId: asString(principal && principal.userId),
      email: asString(principal && principal.email),
      displayName: asString(principal && principal.displayName),
      identityProvider: asString(principal && principal.identityProvider)
    }
  };
}

function json(status, body) {
  return {
    status,
    headers: {
      "content-type": "application/json"
    },
    body
  };
}

module.exports = async function (context, req) {
  const method = asString(req && req.method).toUpperCase() || "GET";
  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }

  const principal = parsePrincipal(req);
  if (!principal) {
    context.res = json(401, { ok: false, error: "Not authenticated." });
    return;
  }

  try {
    const connectionString = asString(process.env.STORAGE_CONNECTION_STRING);
    if (!connectionString) {
      context.res = json(500, { ok: false, error: "Missing STORAGE_CONNECTION_STRING" });
      return;
    }

    const userClient = await getTableClient(connectionString, USERS_TABLE);
    const tenantClient = await getTableClient(connectionString, TENANTS_TABLE);

    if (method === "GET") {
      const userEntity = await getUserEntity(userClient, principal.email);
      const usersExist = userEntity ? true : await anyUsersExist(userClient);
      const allTenants = await listTenants(tenantClient);
      const canBootstrap = !userEntity && !usersExist;

      context.res = json(200, buildMeResponse(principal, userEntity, allTenants, canBootstrap));
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { ok: false, error: "Method not allowed." });
      return;
    }

    const body = asObject(req && req.body);
    const op = asString(body.op).toLowerCase();
    if (op !== "bootstrap") {
      context.res = json(400, { ok: false, error: "Unsupported operation." });
      return;
    }

    let userEntity = await getUserEntity(userClient, principal.email);
    if (!userEntity) {
      const usersExist = await anyUsersExist(userClient);
      if (usersExist) {
        context.res = json(403, {
          ok: false,
          error: "Workspace already initialized. Ask an admin to grant access."
        });
        return;
      }

      const locationName = asString(body.locationName || "Exodus 4x4").slice(0, 120) || "Exodus 4x4";
      const locationId = sanitizeTenantId(asString(body.locationId || locationName || "exodus-4x4"));
      if (!locationId) {
        context.res = json(400, { ok: false, error: "Invalid location id." });
        return;
      }

      const now = new Date().toISOString();
      await tenantClient.upsertEntity(
        {
          partitionKey: TENANTS_PARTITION,
          rowKey: locationId,
          name: locationName,
          status: "active",
          updatedAt: now,
          createdAt: now
        },
        "Merge"
      );

      const roles = normalizeRoleList(["authenticated", "admin"]);
      await userClient.upsertEntity(
        {
          partitionKey: USERS_PARTITION,
          rowKey: principal.email,
          userId: asString(principal.userId || principal.email),
          email: principal.email,
          displayName: asString(principal.displayName || principal.email),
          identityProvider: asString(principal.identityProvider || "unknown"),
          rolesJson: JSON.stringify(roles),
          isSuperAdmin: true,
          allLocations: true,
          defaultLocationId: locationId,
          locationIdsJson: JSON.stringify([locationId]),
          updatedAt: now,
          createdAt: now
        },
        "Merge"
      );

      userEntity = await getUserEntity(userClient, principal.email);
    }

    const allTenants = await listTenants(tenantClient);
    context.res = json(200, buildMeResponse(principal, userEntity, allTenants, false));
  } catch (err) {
    context.log.error(err);
    context.res = json(500, {
      ok: false,
      error: "Server error",
      detail: String((err && err.message) || err)
    });
  }
};
