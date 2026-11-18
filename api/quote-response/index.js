const { randomUUID } = require("node:crypto");
const { scopedTenantPartition } = require("../_shared/notification-partition");
const { TableClient, isSqlBackendEnabled } = require("../_shared/table-client");
const { resolveTenantId } = require("../_shared/tenant");
const { resolveStaff, isActiveTenantUser } = require("../_shared/staff-access");
const { isPortalToken, allowsPortalAction } = require("../_shared/customer-portal");

const TABLE = "quoteresponses";
const NOTIFICATIONS_TABLE = "notifications";
const USERS_TABLE = "useraccess";
const USERS_PARTITION = "v1";

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

const PUBLIC_QUOTE_FIELDS = [
  "quoteId", "quoteNumber", "customerName", "customerEmail", "customerPhone", "customerAddress",
  "vehicle", "businessName", "businessEmail", "businessPhone", "businessAddress", "businessLogoUrl",
  "issueDate", "dueDate", "description", "customerNote", "subtotal", "taxTotal", "total"
];
const PUBLIC_QUOTE_LINE_FIELDS = [
  "type", "code", "description", "quantity", "unitPrice", "taxRate", "lineSubtotal", "taxAmount", "lineTotal"
];

function pickFields(source, fields) {
  const out = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) out[field] = source[field];
  }
  return out;
}

function publicQuoteData(value) {
  const source = asObject(value);
  return {
    ...pickFields(source, PUBLIC_QUOTE_FIELDS),
    lineItems: Array.isArray(source.lineItems)
      ? source.lineItems.map(item => pickFields(asObject(item), PUBLIC_QUOTE_LINE_FIELDS))
      : []
  };
}

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body
  };
}

function readHeader(headers, key) {
  if (!headers || typeof headers !== "object") return "";
  const direct = headers[key];
  if (direct != null) return asString(direct);
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (String(name || "").toLowerCase() !== lower) continue;
    return asString(value);
  }
  return "";
}

function readQueryParam(req, key) {
  const target = asString(key).toLowerCase();
  if (req && req.query && typeof req.query === "object") {
    if (req.query[key] != null) return asString(req.query[key]);
    for (const [name, value] of Object.entries(req.query)) {
      if (asString(name).toLowerCase() === target) return asString(value);
    }
  }
  const rawUrl = asString(req && req.url);
  if (!rawUrl || rawUrl.indexOf("?") < 0) return "";
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    const direct = parsed.searchParams.get(key);
    if (direct != null) return asString(direct);
    for (const [name, value] of parsed.searchParams.entries()) {
      if (asString(name).toLowerCase() === target) return asString(value);
    }
    return "";
  } catch {
    return "";
  }
}

function normalizeEmail(value) {
  return asString(value).toLowerCase();
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

function escapedFilterValue(value) {
  return asString(value).replace(/'/g, "''");
}

function normalizeAction(value) {
  const action = asString(value).toLowerCase();
  if (action === "accept" || action === "accepted") return "accept";
  if (action === "decline" || action === "declined") return "decline";
  return "";
}

function rowKeyForNotification(quoteId, stage, recipientKey) {
  return String(`quote-${quoteId}-${stage}-${recipientKey}`)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 220);
}

async function getTableClient(tableName) {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn && !isSqlBackendEnabled()) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn, tableName);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

async function listTenantRecipients(userClient, tenantId) {
  const out = [];
  const seen = new Set();
  const filter = `PartitionKey eq '${escapedFilterValue(USERS_PARTITION)}'`;
  const iter = userClient.listEntities({ queryOptions: { filter } });
  for await (const entity of iter) {
    if (!isActiveTenantUser(entity, tenantId)) continue;
    const userId = asString(entity.userId || entity.rowKey);
    const rawEmail = asString(entity.email);
    const email = normalizeEmail(rawEmail.includes("@") ? rawEmail : "");
    if (!userId && !email) continue;
    const dedupe = `${userId}|${email}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      targetUserId: userId,
      targetEmail: email,
      targetDisplayName: asString(entity.displayName || email || userId)
    });
  }
  return out;
}


async function createQuoteStageNotifications(notificationClient, userClient, tenantId, payload) {
  const quoteId = asString(payload.quoteId);
  if (!quoteId) return 0;
  const stage = asString(payload.stage).toLowerCase() === "declined" ? "declined" : "accepted";
  const action = stage === "accepted" ? "accept" : "decline";
  let recipients = await listTenantRecipients(userClient, tenantId);
  const actor = payload && payload.actor ? payload.actor : null;
  if (actor) {
    recipients.push({
      targetUserId: asString(actor.userId),
      targetEmail: normalizeEmail(actor.email),
      targetDisplayName: asString(actor.displayName || actor.email || actor.userId)
    });
  }
  const deduped = new Map();
  for (const recipient of recipients) {
    const key = `${asString(recipient.targetUserId).toLowerCase()}|${normalizeEmail(recipient.targetEmail)}`;
    if (!key || key === "|") continue;
    if (!deduped.has(key)) deduped.set(key, recipient);
  }
  recipients = Array.from(deduped.values());
  if (!recipients.length) return 0;

  const quoteNumber = asString(payload.quoteNumber) || quoteId;
  const customerName = asString(payload.customerName) || "Customer";
  const nowIso = new Date().toISOString();
  let count = 0;

  for (const recipient of recipients) {
    const recipientKey = asString(recipient.targetEmail || recipient.targetUserId);
    if (!recipientKey) continue;
    const rowKey = rowKeyForNotification(quoteId, stage, recipientKey);
    try {
      await notificationClient.createEntity({
        partitionKey: scopedTenantPartition(tenantId),
        tenantId,
        rowKey,
        type: "quote-response",
        title: `Quote ${quoteNumber} ${stage}`,
        message: `${customerName} ${stage === "accepted" ? "accepted" : "declined"} quote ${quoteNumber}.`,
        route: `/quotes/${encodeURIComponent(quoteId)}`,
        entityType: "quote",
        entityId: quoteId,
        metadataJson: JSON.stringify({
          quoteId,
          quoteNumber,
          customerName,
          action,
          stage,
          source: "public-quote-link"
        }),
        targetUserId: asString(recipient.targetUserId),
        targetEmail: normalizeEmail(recipient.targetEmail),
        targetDisplayName: asString(recipient.targetDisplayName),
        actorUserId: "",
        actorEmail: "",
        actorDisplayName: "Customer",
        read: false,
        readAt: "",
        createdAt: nowIso,
        updatedAt: nowIso
      });
      count += 1;
    } catch (error) {
      if (error.statusCode !== 409) throw error;
    }
  }

  return count;
}

module.exports = async function (context, req) {
  const method = asString(req && req.method).toUpperCase() || "GET";
  const body = req && req.body && typeof req.body === "object" ? req.body : {};
  const tenantId = resolveTenantId(req, body);

  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }

  try {
    const client = await getTableClient(TABLE);
    const notificationClient = await getTableClient(NOTIFICATIONS_TABLE);
    const userClient = await getTableClient(USERS_TABLE);
    const { actor, authorized: staffAuthorized } = await resolveStaff(req, userClient, tenantId);

    if (method === "GET") {
      const publicToken = asString(readQueryParam(req, "publicToken"));
      if (!staffAuthorized && !publicToken) {
        context.res = json(actor ? 403 : 401, { ok: false, error: "Authorized staff session required." });
        return;
      }

      const quoteId = asString(readQueryParam(req, "quoteId"));
      if (publicToken && !quoteId) {
        context.res = json(400, { ok: false, error: "quoteId is required for a public link." });
        return;
      }
      if (quoteId) {
        try {
          const item = await client.getEntity(tenantId, quoteId);
          if (publicToken) {
            if (asString(item.publicToken) !== publicToken) {
              context.res = json(404, { ok: false, error: "Quote not found." });
              return;
            }
            context.res = json(200, {
              ok: true,
              tenantId,
              item: {
                quoteId,
                publicToken,
                quoteData: publicQuoteData(parseJson(item.quoteDataJson, null)),
                quoteNumber: asString(item.quoteNumber),
                customerName: asString(item.customerName),
                vehicle: asString(item.vehicle),
                businessName: asString(item.businessName),
                updatedAt: asString(item.updatedAt)
              }
            });
            return;
          }
          context.res = json(200, {
            ok: true,
            tenantId,
            item: {
              quoteId,
              action: asString(item.action),
              stage: asString(item.stage),
              quoteNumber: asString(item.quoteNumber),
              updatedAt: asString(item.updatedAt)
            }
          });
          return;
        } catch (err) {
          if (err.statusCode !== 404) throw err;
          context.res = publicToken ? json(404, { ok: false, error: "Quote not found." }) : json(200, { ok: true, tenantId, item: null });
          return;
        }
      }

      const limitRaw = Number(readQueryParam(req, "limit"));
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 200;
      const safeTenant = asString(tenantId).replace(/'/g, "''");
      const out = [];
      const iter = client.listEntities({
        queryOptions: { filter: `PartitionKey eq '${safeTenant}'` }
      });
      for await (const entity of iter) {
        out.push({
          quoteId: asString(entity.rowKey),
          action: asString(entity.action),
          stage: asString(entity.stage),
          quoteNumber: asString(entity.quoteNumber),
          updatedAt: asString(entity.updatedAt)
        });
      }
      out.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      context.res = json(200, { ok: true, tenantId, items: out.slice(0, limit) });
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { ok: false, error: "Method not allowed." });
      return;
    }

    const quoteId = asString(body.quoteId || body.id);
    const op = asString(body.op || body.operation || body.action).toLowerCase();
    if (op === "publish-snapshot" || op === "publishsnapshot") {
      if (!staffAuthorized) {
        context.res = json(actor ? 403 : 401, { ok: false, error: "Authorized staff session required." });
        return;
      }
      if (!quoteId) {
        context.res = json(400, { ok: false, error: "quoteId is required." });
        return;
      }
      const publicToken = asString(body.publicToken);
      if (!publicToken) {
        context.res = json(400, { ok: false, error: "publicToken is required." });
        return;
      }
      const quoteData = publicQuoteData(body.quoteData);
      const now = new Date().toISOString();
      await client.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: quoteId,
          quoteId,
          publicToken,
          revision: randomUUID(),
          quoteDataJson: JSON.stringify(quoteData),
          quoteNumber: asString(body.quoteNumber || quoteData.quoteNumber),
          customerName: asString(body.customerName || quoteData.customerName),
          vehicle: asString(body.vehicle || quoteData.vehicle),
          businessName: asString(body.businessName || quoteData.businessName),
          snapshotUpdatedAt: now,
          updatedAt: now
        },
        "Merge"
      );
      context.res = json(200, { ok: true, tenantId, quoteId, publicToken, updatedAt: now });
      return;
    }

    const action = normalizeAction(body.action);
    if (!quoteId) {
      context.res = json(400, { ok: false, error: "quoteId is required." });
      return;
    }
    if (!action) {
      context.res = json(400, { ok: false, error: "action must be `accept` or `decline`." });
      return;
    }

    // Customer actions always require the token issued for this exact tenant and quote,
    // even when a staff member opens the public link while signed in.
    let snapshot;
    try { snapshot = await client.getEntity(tenantId, quoteId); }
    catch (err) { if (err.statusCode !== 404) throw err; }
    const publicToken = asString(body.publicToken);
    const portalLink = isPortalToken(publicToken);
    const authorizedLink = snapshot && publicToken && (portalLink
      ? await allowsPortalAction(tenantId, publicToken, "quote", quoteId)
      : publicToken === asString(snapshot.publicToken));
    if (!authorizedLink) {
      context.res = json(404, { ok: false, error: "Quote not found or link is invalid." });
      return;
    }

    const now = new Date().toISOString();
    const stage = action === "accept" ? "accepted" : "declined";
    const decision = {
        partitionKey: tenantId,
        rowKey: quoteId,
        quoteId,
        action,
        stage,
        quoteNumber: asString(snapshot.quoteNumber),
        customerName: asString(snapshot.customerName),
        vehicle: asString(snapshot.vehicle),
        businessName: asString(snapshot.businessName),
        updatedAt: now,
        revision: randomUUID()
    };
    if (portalLink && (snapshot.etag || snapshot.revision)) {
      const replacement = { ...snapshot, ...decision };
      delete replacement.etag;
      delete replacement.timestamp;
      try {
        if (typeof client.replaceIfRevision === "function") {
          if (!await client.replaceIfRevision(replacement, snapshot.revision)) {
            context.res = json(409, { ok: false, error: "The quote changed. Refresh before responding." });
            return;
          }
        } else {
          await client.updateEntity(replacement, "Replace", { etag: snapshot.etag });
        }
      } catch (error) {
        if (![404, 412].includes(error.statusCode)) throw error;
        context.res = json(409, { ok: false, error: "The quote changed. Refresh before responding." });
        return;
      }
    } else {
      await client.upsertEntity(decision, "Merge");
    }

    const notificationsCreated = await createQuoteStageNotifications(notificationClient, userClient, tenantId, {
      quoteId,
      quoteNumber: asString(snapshot.quoteNumber),
      customerName: asString(snapshot.customerName),
      stage,
      actor: staffAuthorized ? actor : null
    });

    context.res = json(200, {
      ok: true,
      tenantId,
      quoteId,
      action,
      stage,
      updatedAt: now,
      notificationsCreated
    });
  } catch (err) {
    context.log?.error?.("Quote operation failed.");
    context.res = json(500, {
      ok: false,
      error: "Quote operation could not be completed. Please retry."
    });
  }
};
