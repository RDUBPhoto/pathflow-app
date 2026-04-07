const crypto = require("crypto");
const { TableClient } = require("./table-client");

const SESSIONS_TABLE = "authsessions";
const AUTH_SESSION_COOKIE = "pf_session";
const SESSION_PARTITION = "v1";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return {};
}

function normalizeEmail(value) {
  return asString(value).toLowerCase();
}

function normalizeRoleList(values) {
  const out = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = asString(value).toLowerCase();
    if (!normalized) continue;
    out.add(normalized);
  }
  if (!out.has("authenticated")) out.add("authenticated");
  return Array.from(out);
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

function parseJson(value, fallback) {
  const raw = asString(value);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function parseCookies(req) {
  const raw = readHeader(req && req.headers, "cookie");
  if (!raw) return {};
  const out = {};
  for (const chunk of raw.split(";")) {
    const [name, ...rest] = String(chunk || "").split("=");
    const key = asString(name);
    if (!key) continue;
    out[key] = decodeURIComponent(rest.join("=") || "");
  }
  return out;
}

function extractSessionToken(req) {
  const cookies = parseCookies(req);
  const cookieToken = asString(cookies[AUTH_SESSION_COOKIE]);
  if (cookieToken) return cookieToken;

  const authz = asString(readHeader(req && req.headers, "authorization"));
  if (!authz) return "";
  const match = authz.match(/^Bearer\s+(.+)$/i);
  return asString(match && match[1]);
}

function isLoopbackHost(rawHost) {
  const host = asString(rawHost).split(",")[0].trim().toLowerCase();
  const hostname = host.split(":")[0].toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost");
}

function parseSwaPrincipal(req) {
  const encoded = readHeader(req && req.headers, "x-ms-client-principal");
  if (!encoded) return null;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const raw = parseJson(decoded, {});
    const claims = Array.isArray(raw.claims) ? raw.claims : [];
    const claimEmail =
      claims.find(item => asString(item && item.typ).toLowerCase() === "emails")?.val ||
      claims.find(item => asString(item && item.typ).toLowerCase() === "email")?.val ||
      claims.find(item => asString(item && item.typ).toLowerCase() === "preferred_username")?.val;
    const userDetails = asString(raw.userDetails);
    const email = normalizeEmail(claimEmail || (userDetails.includes("@") ? userDetails : ""));
    const userId = asString(raw.userId || email);
    if (!userId && !email) return null;
    return {
      source: "swa",
      userId,
      email,
      displayName: asString(userDetails || email || userId),
      identityProvider: asString(raw.identityProvider || "unknown"),
      userRoles: normalizeRoleList(raw.userRoles || [])
    };
  } catch {
    return null;
  }
}

function parseDevPrincipal(req) {
  const host = readHeader(req && req.headers, "x-forwarded-host") || readHeader(req && req.headers, "host");
  if (!isLoopbackHost(host)) return null;
  const email = normalizeEmail(readHeader(req && req.headers, "x-dev-user-email"));
  if (!email) return null;
  const displayName = asString(readHeader(req && req.headers, "x-dev-user-name")) || email;
  const userId = asString(readHeader(req && req.headers, "x-dev-user-id")) || email;
  const rolesHeader = asString(readHeader(req && req.headers, "x-dev-user-roles"));
  const roles = normalizeRoleList(
    rolesHeader
      .split(",")
      .map(value => asString(value).toLowerCase())
      .filter(Boolean)
  );
  return {
    source: "dev",
    userId,
    email,
    displayName,
    identityProvider: "dev-local",
    userRoles: roles
  };
}

async function getTableClient(tableName) {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn, tableName);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

function escapedFilterValue(value) {
  return asString(value).replace(/'/g, "''");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(asString(token)).digest("hex");
}

function hashPassword(password, salt, iterations = 120000) {
  const resolvedSalt = asString(salt) || crypto.randomBytes(16).toString("hex");
  const key = crypto.pbkdf2Sync(asString(password), resolvedSalt, iterations, 32, "sha256");
  return {
    hash: key.toString("hex"),
    salt: resolvedSalt,
    iterations,
    digest: "sha256"
  };
}

function verifyPassword(password, record) {
  const salt = asString(record && record.passwordSalt);
  const expected = asString(record && record.passwordHash);
  const iterations = Number(record && record.passwordIterations) || 120000;
  const digest = asString(record && record.passwordDigest).toLowerCase() || "sha256";
  if (!salt || !expected || digest !== "sha256") return false;
  const key = crypto.pbkdf2Sync(asString(password), salt, iterations, 32, "sha256");
  const actual = key.toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function createSessionCookie(token, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)) {
  const secure = asString(process.env.NODE_ENV).toLowerCase() !== "development";
  const parts = [
    `${AUTH_SESSION_COOKIE}=${encodeURIComponent(asString(token))}`,
    "Path=/",
    `Max-Age=${Math.max(0, Number(maxAgeSeconds) || 0)}`,
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookie() {
  const secure = asString(process.env.NODE_ENV).toLowerCase() !== "development";
  const parts = [
    `${AUTH_SESSION_COOKIE}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

async function persistSession(sessionClient, principal, options) {
  const now = new Date();
  const ttlMs = Number(options && options.ttlMs) > 0 ? Number(options.ttlMs) : SESSION_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttlMs);
  const rawToken = crypto.randomBytes(48).toString("hex");
  const rowKey = hashToken(rawToken);
  const roles = normalizeRoleList(principal && principal.userRoles);

  await sessionClient.upsertEntity(
    {
      partitionKey: SESSION_PARTITION,
      rowKey,
      sessionId: rowKey,
      userId: asString(principal && principal.userId),
      email: normalizeEmail(principal && principal.email),
      displayName: asString(principal && principal.displayName),
      identityProvider: asString(principal && principal.identityProvider) || "app",
      rolesJson: JSON.stringify(roles),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      revoked: false
    },
    "Merge"
  );

  return {
    token: rawToken,
    sessionId: rowKey,
    expiresAt: expiresAt.toISOString(),
    roles
  };
}

async function readSessionPrincipal(req, sessionClient) {
  const rawToken = extractSessionToken(req);
  if (!rawToken) return null;
  const key = hashToken(rawToken);
  let entity;
  try {
    entity = await sessionClient.getEntity(SESSION_PARTITION, key);
  } catch {
    return null;
  }
  if (!entity || entity.revoked) return null;
  const expiresAtMs = Date.parse(asString(entity.expiresAt));
  if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) {
    try {
      await sessionClient.deleteEntity(SESSION_PARTITION, key);
    } catch (_) {}
    return null;
  }

  const roles = normalizeRoleList(parseJson(entity.rolesJson, []));
  const nowIso = new Date().toISOString();
  try {
    await sessionClient.upsertEntity(
      {
        partitionKey: SESSION_PARTITION,
        rowKey: key,
        lastSeenAt: nowIso,
        updatedAt: nowIso
      },
      "Merge"
    );
  } catch (_) {}

  return {
    source: "session",
    sessionId: key,
    userId: asString(entity.userId || entity.email),
    email: normalizeEmail(entity.email),
    displayName: asString(entity.displayName || entity.email),
    identityProvider: asString(entity.identityProvider || "app"),
    userRoles: roles
  };
}

async function resolvePrincipal(req, options = {}) {
  const allowSwa = options.allowSwa !== false;
  const allowDev = options.allowDev !== false;

  try {
    const sessionClient = await getTableClient(SESSIONS_TABLE);
    const sessionPrincipal = await readSessionPrincipal(req, sessionClient);
    if (sessionPrincipal) return sessionPrincipal;
  } catch (_) {}

  if (allowSwa) {
    const swa = parseSwaPrincipal(req);
    if (swa) return swa;
  }

  if (allowDev) {
    const dev = parseDevPrincipal(req);
    if (dev) return dev;
  }

  return null;
}

async function issueSession(principal, options = {}) {
  const sessionClient = await getTableClient(SESSIONS_TABLE);
  return persistSession(sessionClient, principal, options);
}

async function revokeSession(req) {
  const rawToken = extractSessionToken(req);
  if (!rawToken) return;
  const key = hashToken(rawToken);
  const sessionClient = await getTableClient(SESSIONS_TABLE);
  try {
    await sessionClient.deleteEntity(SESSION_PARTITION, key);
  } catch (_) {}
}

async function requirePrincipal(context, req, options = {}) {
  const principal = await resolvePrincipal(req, options);
  if (principal) return principal;
  context.res = {
    status: 401,
    headers: { "content-type": "application/json" },
    body: { ok: false, error: "Not authenticated." }
  };
  return null;
}

module.exports = {
  AUTH_SESSION_COOKIE,
  SESSION_TTL_MS,
  asString,
  asObject,
  normalizeEmail,
  normalizeRoleList,
  readHeader,
  parseJson,
  getTableClient,
  hashPassword,
  verifyPassword,
  resolvePrincipal,
  requirePrincipal,
  issueSession,
  revokeSession,
  createSessionCookie,
  clearSessionCookie,
  escapedFilterValue
};
