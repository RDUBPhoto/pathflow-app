const { TableClient } = require("../_shared/table-client");
const { randomUUID } = require("crypto");
const { resolveTenantId, sanitizeTenantId } = require("../_shared/tenant");

const NOTIFICATIONS_TABLE = "notifications";
const USERS_TABLE = "useraccess";
const USERS_PARTITION = "v1";
const TENANT_SCOPE_DELIMITER = "::";
const DEFAULT_RECENT_LIMIT = 3;
const DEFAULT_ALL_LIMIT = 100;
const MAX_LIMIT = 250;
const NOTIFICATIONS_RETENTION_DAYS = 90;
const MAX_NOTIFICATIONS_PER_RECIPIENT = 2000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_PRUNE_DELETES_PER_RUN = 400;
const lastPruneByTenant = new Map();

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asBool(value) {
  if (typeof value === "boolean") return value;
  const lowered = asString(value).toLowerCase();
  return lowered === "true" || lowered === "1" || lowered === "yes";
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

function parseJson(value, fallback) {
  const raw = asString(value);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeEmail(value) {
  return asString(value).toLowerCase();
}

function readHeader(headers, key) {
  if (!headers || typeof headers !== "object") return "";
  const direct = headers[key];
  if (direct != null) return asString(direct);
  const target = asString(key).toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (asString(name).toLowerCase() === target) return asString(value);
  }
  return "";
}

function readQueryParam(req, key) {
  if (req && req.query && req.query[key] != null) return asString(req.query[key]);
  const rawUrl = asString(req && req.url);
  if (!rawUrl || rawUrl.indexOf("?") < 0) return "";
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    return asString(parsed.searchParams.get(key));
  } catch {
    return "";
  }
}

function escapedFilterValue(value) {
  return asString(value).replace(/'/g, "''");
}

function parseLimit(rawValue, fallback) {
  const parsed = Number(asString(rawValue));
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

function parseOffset(rawValue) {
  const parsed = Number(asString(rawValue));
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.max(0, Math.floor(parsed));
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

    const claimName = claims.find(item => asString(item && item.typ).toLowerCase() === "name")?.val;
    const userDetails = asString(raw.userDetails);
    const email = normalizeEmail(claimEmail || (userDetails.includes("@") ? userDetails : ""));
    const userId = asString(raw.userId || email);
    if (!userId && !email) return null;

    return {
      userId,
      email,
      displayName: asString(claimName || userDetails || email || "User")
    };
  } catch {
    return null;
  }
}

function parseFallbackIdentity(req, body) {
  const source = asObject(body);
  const userId = asString(
    source.actorUserId ||
      source.userId ||
      readHeader(req && req.headers, "x-user-id") ||
      readQueryParam(req, "userId")
  );
  const email = normalizeEmail(
    source.actorEmail ||
      source.userEmail ||
      source.email ||
      readHeader(req && req.headers, "x-user-email") ||
      readQueryParam(req, "userEmail")
  );
  const displayName = asString(
    source.actorDisplayName ||
      source.userDisplayName ||
      source.displayName ||
      readHeader(req && req.headers, "x-user-name") ||
      readQueryParam(req, "userName") ||
      email ||
      userId
  );
  if (!userId && !email) return null;
  return { userId, email, displayName };
}

function resolveActor(req, body) {
  const principal = parsePrincipal(req);
  const fallback = parseFallbackIdentity(req, body);
  if (isLocalRequest(req) && fallback) return fallback;
  return principal || fallback;
}

function isLocalRequest(req) {
  const host = asString(readHeader(req && req.headers, "x-forwarded-host") || readHeader(req && req.headers, "host")).toLowerCase();
  return host.includes("localhost") || host.includes("127.0.0.1");
}

function isLocalRuntime() {
  const websiteHostname = asString(process.env.WEBSITE_HOSTNAME).toLowerCase();
  if (!websiteHostname) return true;
  return websiteHostname.includes("localhost") || websiteHostname.includes("127.0.0.1");
}

function notificationsScope() {
  const explicit = sanitizeTenantId(
    asString(process.env.NOTIFICATIONS_NAMESPACE || process.env.APP_ENV || process.env.NODE_ENV)
  );
  if (explicit && explicit !== "tenant-unassigned") return explicit;
  return isLocalRuntime() ? "local" : "prod";
}

function scopedTenantPartition(tenantId) {
  const baseTenant = sanitizeTenantId(asString(tenantId) || "main");
  return `${baseTenant}${TENANT_SCOPE_DELIMITER}${notificationsScope()}`;
}

function baseTenantFromPartition(partitionKey) {
  const raw = asString(partitionKey);
  const idx = raw.indexOf(TENANT_SCOPE_DELIMITER);
  const value = idx >= 0 ? raw.slice(0, idx) : raw;
  return sanitizeTenantId(value || "main");
}

function matchesRecipient(actor, entity) {
  if (!actor) return false;
  const actorUserId = asString(actor.userId);
  const actorEmail = normalizeEmail(actor.email);
  const targetUserId = asString(entity.targetUserId);
  const targetEmail = normalizeEmail(entity.targetEmail);
  if (actorUserId && targetUserId && actorUserId === targetUserId) return true;
  if (actorEmail && targetEmail && actorEmail === targetEmail) return true;
  return false;
}

function toNotification(entity) {
  return {
    id: asString(entity.rowKey),
    tenantId: sanitizeTenantId(asString(entity.tenantId) || baseTenantFromPartition(entity.partitionKey)),
    type: asString(entity.type || "mention"),
    title: asString(entity.title),
    message: asString(entity.message),
    route: asString(entity.route || "/dashboard"),
    entityType: asString(entity.entityType || "item"),
    entityId: asString(entity.entityId) || null,
    metadata: parseJson(entity.metadataJson, {}),
    targetUserId: asString(entity.targetUserId) || null,
    targetEmail: asString(entity.targetEmail) || null,
    targetDisplayName: asString(entity.targetDisplayName) || null,
    actorUserId: asString(entity.actorUserId) || null,
    actorEmail: asString(entity.actorEmail) || null,
    actorDisplayName: asString(entity.actorDisplayName) || null,
    read: asBool(entity.read),
    readAt: asString(entity.readAt) || null,
    createdAt: asString(entity.createdAt) || new Date().toISOString()
  };
}

function sortByCreatedDesc(a, b) {
  const ta = Date.parse(asString(a.createdAt));
  const tb = Date.parse(asString(b.createdAt));
  if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
  if (Number.isFinite(tb)) return 1;
  if (Number.isFinite(ta)) return -1;
  return String(b.id || "").localeCompare(String(a.id || ""));
}

async function getTableClient(connectionString, tableName) {
  const client = TableClient.fromConnectionString(connectionString, tableName);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

function buildRecipientFilter(tenantId, actor) {
  if (!actor) return "";
  const filters = [];
  const userId = asString(actor.userId);
  const email = normalizeEmail(actor.email);
  if (userId) filters.push(`targetUserId eq '${escapedFilterValue(userId)}'`);
  if (email) filters.push(`targetEmail eq '${escapedFilterValue(email)}'`);
  if (!filters.length) return "";
  return `PartitionKey eq '${escapedFilterValue(tenantId)}' and (${filters.join(" or ")})`;
}

async function listUserNotifications(notificationClient, tenantId, actor, unreadOnly = false) {
  const recipientFilter = buildRecipientFilter(scopedTenantPartition(tenantId), actor);
  if (!recipientFilter) return [];
  const filter = unreadOnly ? `${recipientFilter} and read eq false` : recipientFilter;

  const items = [];
  const iter = notificationClient.listEntities({ queryOptions: { filter } });
  for await (const entity of iter) {
    items.push(toNotification(entity));
  }
  items.sort(sortByCreatedDesc);
  return items;
}

function recipientKeyForNotification(item) {
  const userId = asString(item && item.targetUserId);
  const email = normalizeEmail(item && item.targetEmail);
  if (userId) return `u:${userId}`;
  if (email) return `e:${email}`;
  return "";
}

function shouldPruneTenant(tenantId) {
  const key = sanitizeTenantId(asString(tenantId) || "main");
  const now = Date.now();
  const last = Number(lastPruneByTenant.get(key) || 0);
  if (Number.isFinite(last) && now - last < PRUNE_INTERVAL_MS) return false;
  lastPruneByTenant.set(key, now);
  return true;
}

async function pruneNotifications(notificationClient, tenantId) {
  const safeTenant = scopedTenantPartition(tenantId);
  if (!shouldPruneTenant(safeTenant)) return 0;

  const filter = `PartitionKey eq '${escapedFilterValue(safeTenant)}'`;
  const notifications = [];
  const iter = notificationClient.listEntities({ queryOptions: { filter } });
  for await (const entity of iter) {
    notifications.push(toNotification(entity));
  }
  if (!notifications.length) return 0;

  notifications.sort(sortByCreatedDesc);
  const now = Date.now();
  const retentionMs = NOTIFICATIONS_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = now - retentionMs;
  const countsByRecipient = new Map();
  const toDelete = [];

  for (const item of notifications) {
    const recipientKey = recipientKeyForNotification(item);
    if (!recipientKey) continue;

    const currentCount = Number(countsByRecipient.get(recipientKey) || 0) + 1;
    countsByRecipient.set(recipientKey, currentCount);
    const createdAtMs = Date.parse(asString(item.createdAt));
    const tooOld = Number.isFinite(createdAtMs) && createdAtMs < cutoff;
    const aboveRecipientCap = currentCount > MAX_NOTIFICATIONS_PER_RECIPIENT;
    if (!tooOld && !aboveRecipientCap) continue;

    toDelete.push(item);
    if (toDelete.length >= MAX_PRUNE_DELETES_PER_RUN) break;
  }

  if (!toDelete.length) return 0;

  let deleted = 0;
  for (const item of toDelete) {
    const id = asString(item.id);
    if (!id) continue;
    try {
      await notificationClient.deleteEntity(safeTenant, id);
      deleted += 1;
    } catch (_) {}
  }
  return deleted;
}

function parseUserLocationIds(userEntity) {
  const parsed = parseJson(userEntity && userEntity.locationIdsJson, []);
  const out = new Set();
  for (const item of Array.isArray(parsed) ? parsed : []) {
    const id = sanitizeTenantId(asString(item));
    if (!id) continue;
    out.add(id);
  }
  return Array.from(out);
}

function userCanAccessTenant(userEntity, tenantId) {
  if (asBool(userEntity && userEntity.allLocations)) return true;
  const locations = parseUserLocationIds(userEntity);
  if (!locations.length) return true;
  return locations.includes(tenantId);
}

async function listMentionableUsers(userClient, tenantId, search) {
  const filter = `PartitionKey eq '${escapedFilterValue(USERS_PARTITION)}'`;
  const normalizedSearch = asString(search).toLowerCase();
  const seen = new Set();
  const out = [];
  const iter = userClient.listEntities({ queryOptions: { filter } });

  for await (const entity of iter) {
    if (!userCanAccessTenant(entity, tenantId)) continue;
    const email = normalizeEmail(entity.email || entity.rowKey);
    if (!email) continue;
    if (seen.has(email)) continue;

    const displayName = asString(entity.displayName || email);
    const id = asString(entity.userId || email);
    const haystack = `${displayName} ${email}`.toLowerCase();
    if (normalizedSearch && !haystack.includes(normalizedSearch)) continue;

    const roles = parseJson(entity.rolesJson, []);
    out.push({
      id,
      email,
      displayName,
      roles: Array.isArray(roles) ? roles.map(item => asString(item).toLowerCase()).filter(Boolean) : []
    });
    seen.add(email);
  }

  out.sort((a, b) => {
    const byName = a.displayName.localeCompare(b.displayName);
    if (byName !== 0) return byName;
    return a.email.localeCompare(b.email);
  });
  return out.slice(0, MAX_LIMIT);
}

async function markReadForIds(notificationClient, tenantId, actor, ids) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  const seen = new Set();
  const scopedTenantId = scopedTenantPartition(tenantId);
  let updated = 0;

  for (const value of ids) {
    const id = asString(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    let entity = null;
    try {
      entity = await notificationClient.getEntity(scopedTenantId, id);
    } catch {
      entity = null;
    }
    if (!entity) continue;
    if (!matchesRecipient(actor, entity)) continue;
    if (asBool(entity.read)) continue;

    await notificationClient.upsertEntity(
      {
        partitionKey: scopedTenantId,
        rowKey: id,
        read: true,
        readAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      "Merge"
    );
    updated += 1;
  }

  return updated;
}

module.exports = async function notificationsApi(context, req) {
  const method = asString(req && req.method).toUpperCase();
  if (method === "OPTIONS") {
    context.res = json(200, { ok: true });
    return;
  }

  const connectionString = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!connectionString) {
    context.res = json(500, {
      ok: false,
      error: "Storage connection is not configured."
    });
    return;
  }

  const body = asObject(req && req.body);
  const tenantId = resolveTenantId(req, body);
  const scopedTenantId = scopedTenantPartition(tenantId);
  const actor = resolveActor(req, body);

  try {
    const notificationClient = await getTableClient(connectionString, NOTIFICATIONS_TABLE);

    if (method === "GET") {
      const scope = asString(readQueryParam(req, "scope") || "recent").toLowerCase();
      if (scope === "users") {
        if (!actor) {
          context.res = json(401, { ok: false, error: "Authentication is required." });
          return;
        }
        const userClient = await getTableClient(connectionString, USERS_TABLE);
        const search = readQueryParam(req, "search");
        const users = await listMentionableUsers(userClient, tenantId, search);
        context.res = json(200, {
          ok: true,
          scope: "users",
          items: users
        });
        return;
      }

      if (!actor) {
        context.res = json(401, { ok: false, error: "Authentication is required." });
        return;
      }

      await pruneNotifications(notificationClient, tenantId);

      if (scope === "unreadcount" || scope === "unread-count") {
        const unread = await listUserNotifications(notificationClient, tenantId, actor, true);
        context.res = json(200, {
          ok: true,
          scope: "unreadCount",
          unreadCount: unread.length
        });
        return;
      }

      const all = await listUserNotifications(notificationClient, tenantId, actor, false);
      const unreadCount = all.filter(item => !item.read).length;
      if (scope === "all") {
        const limit = parseLimit(readQueryParam(req, "limit"), DEFAULT_ALL_LIMIT);
        const offset = parseOffset(readQueryParam(req, "offset"));
        const items = all.slice(offset, offset + limit);
        context.res = json(200, {
          ok: true,
          scope: "all",
          unreadCount,
          total: all.length,
          hasMore: offset + items.length < all.length,
          offset,
          limit,
          items
        });
        return;
      }

      const limit = parseLimit(readQueryParam(req, "limit"), DEFAULT_RECENT_LIMIT);
      context.res = json(200, {
        ok: true,
        scope: "recent",
        unreadCount,
        total: all.length,
        hasMore: all.length > limit,
        items: all.slice(0, limit)
      });
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { ok: false, error: "Method not allowed." });
      return;
    }

    const op = asString(body.op || "createMention").toLowerCase();
    if (!actor) {
      context.res = json(401, { ok: false, error: "Authentication is required." });
      return;
    }

    if (op === "createmention" || op === "create") {
      const targetUserId = asString(body.targetUserId || body.userId);
      const targetEmail = normalizeEmail(body.targetEmail || body.userEmail);
      const targetDisplayName = asString(body.targetDisplayName || body.userDisplayName || targetEmail || targetUserId);
      if (!targetUserId && !targetEmail) {
        context.res = json(400, {
          ok: false,
          error: "targetUserId or targetEmail is required."
        });
        return;
      }

      const route = asString(body.route || "/dashboard");
      const title = asString(body.title || `${actor.displayName || actor.email || "A teammate"} mentioned you`);
      const message = asString(body.message || "You were mentioned in an update.");
      const entityType = asString(body.entityType || "item");
      const entityId = asString(body.entityId);
      const metadata = asObject(body.metadata);
      const id = randomUUID();
      const nowIso = new Date().toISOString();

      await notificationClient.upsertEntity(
        {
          partitionKey: scopedTenantId,
          rowKey: id,
          tenantId,
          type: "mention",
          title,
          message,
          route,
          entityType,
          entityId,
          metadataJson: JSON.stringify(metadata),
          targetUserId,
          targetEmail,
          targetDisplayName,
          actorUserId: asString(actor.userId),
          actorEmail: normalizeEmail(actor.email),
          actorDisplayName: asString(actor.displayName || actor.email || actor.userId),
          read: false,
          readAt: "",
          createdAt: nowIso,
          updatedAt: nowIso
        },
        "Merge"
      );

      context.res = json(200, {
        ok: true,
        scope: "createMention",
        item: {
          id,
          tenantId,
          type: "mention",
          title,
          message,
          route,
          entityType,
          entityId: entityId || null,
          metadata,
          targetUserId: targetUserId || null,
          targetEmail: targetEmail || null,
          targetDisplayName: targetDisplayName || null,
          actorUserId: asString(actor.userId) || null,
          actorEmail: normalizeEmail(actor.email) || null,
          actorDisplayName: asString(actor.displayName || actor.email || actor.userId) || null,
          read: false,
          readAt: null,
          createdAt: nowIso
        }
      });
      await pruneNotifications(notificationClient, tenantId);
      return;
    }

    if (op === "markread") {
      const id = asString(body.id);
      if (!id) {
        context.res = json(400, { ok: false, error: "id is required." });
        return;
      }

      const updated = await markReadForIds(notificationClient, tenantId, actor, [id]);
      context.res = json(200, { ok: true, id, updated: updated > 0 });
      return;
    }

    if (op === "markreadbatch") {
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const updated = await markReadForIds(notificationClient, tenantId, actor, ids);
      context.res = json(200, { ok: true, updated });
      return;
    }

    if (op === "markallread") {
      const unread = await listUserNotifications(notificationClient, tenantId, actor, true);
      const updated = await markReadForIds(
        notificationClient,
        tenantId,
        actor,
        unread.map(item => item.id)
      );
      context.res = json(200, { ok: true, updated });
      return;
    }

    context.res = json(400, {
      ok: false,
      error: `Unsupported op: ${op || "(empty)"}`
    });
  } catch (err) {
    context.log.error("[notifications] failed", err);
    context.res = json(500, {
      ok: false,
      error: String((err && err.message) || err || "Unknown error")
    });
  }
};
