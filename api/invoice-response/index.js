const { TableClient, isSqlBackendEnabled } = require("../_shared/table-client");
const { resolveTenantId } = require("../_shared/tenant");

const TABLE = "invoiceresponses";
const NOTIFICATIONS_TABLE = "notifications";
const USERS_TABLE = "useraccess";
const USERS_PARTITION = "v1";

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

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json" },
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

function parsePrincipal(req) {
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
    const claimName = claims.find(item => asString(item && item.typ).toLowerCase() === "name")?.val;
    const userDetails = asString(raw.userDetails);
    const email = normalizeEmail(claimEmail || (userDetails.includes("@") ? userDetails : ""));
    const userId = asString(raw.userId || email);
    if (!userId && !email) return null;
    return {
      userId,
      email,
      displayName: asString(claimName || userDetails || email || userId)
    };
  } catch {
    return null;
  }
}

function parseFallbackIdentity(req, body) {
  const source = asObject(body);
  const queryUserId = readQueryParam(req, "userId") || readQueryParam(req, "userid") || readQueryParam(req, "actorUserId");
  const queryUserEmail =
    readQueryParam(req, "userEmail") || readQueryParam(req, "useremail") || readQueryParam(req, "email");
  const queryUserName =
    readQueryParam(req, "userName") || readQueryParam(req, "username") || readQueryParam(req, "displayName");
  const userId = asString(
    source.actorUserId ||
      source.userId ||
      readHeader(req && req.headers, "x-user-id") ||
      queryUserId
  );
  const email = normalizeEmail(
    source.actorEmail ||
      source.userEmail ||
      source.email ||
      readHeader(req && req.headers, "x-user-email") ||
      queryUserEmail
  );
  const displayName = asString(
    source.actorDisplayName ||
      source.userDisplayName ||
      source.displayName ||
      readHeader(req && req.headers, "x-user-name") ||
      queryUserName ||
      email ||
      userId
  );
  if (!userId && !email) return null;
  return { userId, email, displayName };
}

function resolveActor(req, body) {
  return parsePrincipal(req) || parseFallbackIdentity(req, body);
}

function isLocalRequest(req) {
  const host = asString(readHeader(req && req.headers, "x-forwarded-host") || readHeader(req && req.headers, "host")).toLowerCase();
  return host.includes("localhost") || host.includes("127.0.0.1");
}

function normalizeAction(value) {
  const action = asString(value).toLowerCase();
  if (action === "pay" || action === "paid") return "pay";
  return "";
}

function sanitizeAmount(value) {
  const normalized = asString(value).replace(/[^0-9.\-]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function maskCardLast4(value) {
  const digits = asString(value).replace(/\D+/g, "");
  if (digits.length < 4) return "";
  return `XXXX${digits.slice(-4)}`;
}

function rowKeyForNotification(invoiceId, stage, recipientKey) {
  return String(`invoice-${invoiceId}-${stage}-${recipientKey}`)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 220);
}

function parseUserLocationIds(userEntity) {
  const parsed = parseJson(userEntity && userEntity.locationIdsJson, []);
  const out = new Set();
  for (const item of Array.isArray(parsed) ? parsed : []) {
    const id = asString(item).toLowerCase();
    if (!id) continue;
    out.add(id);
  }
  return Array.from(out);
}

function userCanAccessTenant(userEntity, tenantId) {
  if (asBool(userEntity && userEntity.allLocations)) return true;
  if (asBool(userEntity && userEntity.isSuperAdmin)) return true;
  const locations = parseUserLocationIds(userEntity);
  if (!locations.length) return true;
  return locations.includes(asString(tenantId).toLowerCase());
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
    if (!userCanAccessTenant(entity, tenantId)) continue;
    const userId = asString(entity.userId || entity.rowKey);
    const email = normalizeEmail(entity.email || entity.rowKey);
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

async function listAllUserRecipients(userClient) {
  const out = [];
  const seen = new Set();
  const filter = `PartitionKey eq '${escapedFilterValue(USERS_PARTITION)}'`;
  const iter = userClient.listEntities({ queryOptions: { filter } });
  for await (const entity of iter) {
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

async function createInvoicePaidNotifications(notificationClient, userClient, tenantId, payload) {
  const invoiceId = asString(payload.invoiceId);
  if (!invoiceId) return 0;
  const paymentKind = asString(payload.paymentKind).toLowerCase() === "final" ? "final" : "initial";
  let recipients = await listTenantRecipients(userClient, tenantId);
  // Fallback so notifications still appear if tenant access mapping is temporarily incomplete.
  if (!recipients.length) {
    recipients = await listAllUserRecipients(userClient);
  }
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

  const invoiceNumber = asString(payload.invoiceNumber) || invoiceId;
  const customerName = asString(payload.customerName) || "Customer";
  const nowIso = new Date().toISOString();
  const rawLineItems = Array.isArray(payload.lineItems) ? payload.lineItems : [];
  const partsToOrder = rawLineItems
    .filter((line) => {
      const lineType = asString(line && line.type).toLowerCase();
      const status = asString(line && line.partStatus).toLowerCase();
      if (lineType === "labor") return false;
      if (status === "ordered" || status === "received" || status === "in-stock" || status === "in stock") return false;
      const qty = Number(line && line.quantity);
      return Number.isFinite(qty) ? qty > 0 : true;
    });
  let count = 0;

  for (const recipient of recipients) {
    const recipientKey = asString(recipient.targetEmail || recipient.targetUserId);
    if (!recipientKey) continue;
    const rowKey = rowKeyForNotification(invoiceId, "paid", recipientKey);
    await notificationClient.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey,
        type: "invoice-response",
        title: `${paymentKind === "final" ? "Final invoice" : "Invoice"} ${invoiceNumber} paid`,
        message: `${customerName} paid ${paymentKind === "final" ? "final invoice" : "invoice"} ${invoiceNumber}.`,
        route: `/invoices/${encodeURIComponent(invoiceId)}`,
        entityType: "invoice",
        entityId: invoiceId,
        metadataJson: JSON.stringify({
          invoiceId,
          invoiceNumber,
          customerName,
          action: "pay",
          paymentKind,
          source: "public-invoice-link"
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
      },
      "Merge"
    );
    count += 1;

    if (partsToOrder.length) {
      const inventoryRowKey = rowKeyForNotification(invoiceId, "inventory-order-needed", recipientKey);
      await notificationClient.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: inventoryRowKey,
          type: "inventory",
          title: `Parts to order for ${invoiceNumber}`,
          message: `${customerName} paid ${invoiceNumber}. ${partsToOrder.length} part line item(s) need ordering.`,
          route: "/inventory",
          entityType: "invoice",
          entityId: invoiceId,
          metadataJson: JSON.stringify({
            invoiceId,
            invoiceNumber,
            customerName,
            action: "parts-to-order",
            partsToOrderCount: partsToOrder.length,
            source: "invoice-paid"
          }),
          targetUserId: asString(recipient.targetUserId),
          targetEmail: normalizeEmail(recipient.targetEmail),
          targetDisplayName: asString(recipient.targetDisplayName),
          actorUserId: "",
          actorEmail: "",
          actorDisplayName: "System",
          read: false,
          readAt: "",
          createdAt: nowIso,
          updatedAt: nowIso
        },
        "Merge"
      );
      count += 1;
    }
  }

  return count;
}

module.exports = async function (context, req) {
  const method = asString(req && req.method).toUpperCase() || "GET";
  const body = req && req.body && typeof req.body === "object" ? req.body : {};
  const tenantId = resolveTenantId(req, body);
  const actor = resolveActor(req, body);

  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }

  try {
    const client = await getTableClient(TABLE);
    const notificationClient = await getTableClient(NOTIFICATIONS_TABLE);
    const userClient = await getTableClient(USERS_TABLE);

    if (method === "GET") {
      if (!actor && !isLocalRequest(req)) {
        context.res = json(401, { ok: false, error: "Authentication required." });
        return;
      }

      const invoiceId = asString(readQueryParam(req, "invoiceId"));
      if (invoiceId) {
        try {
          const item = await client.getEntity(tenantId, invoiceId);
          context.res = json(200, {
            ok: true,
            tenantId,
            item: {
              invoiceId,
              action: asString(item.action),
              stage: asString(item.stage),
              invoiceNumber: asString(item.invoiceNumber),
              updatedAt: asString(item.updatedAt),
              paymentAmount: Number(item.paymentAmount || 0),
              paymentProvider: asString(item.paymentProvider),
              paymentTransactionId: asString(item.paymentTransactionId),
              paymentAccountNumber: asString(item.paymentAccountNumber)
            }
          });
          return;
        } catch {
          context.res = json(200, { ok: true, tenantId, item: null });
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
          invoiceId: asString(entity.rowKey),
          action: asString(entity.action),
          stage: asString(entity.stage),
          invoiceNumber: asString(entity.invoiceNumber),
          updatedAt: asString(entity.updatedAt),
          paymentAmount: Number(entity.paymentAmount || 0),
          paymentProvider: asString(entity.paymentProvider),
          paymentTransactionId: asString(entity.paymentTransactionId),
          paymentAccountNumber: asString(entity.paymentAccountNumber)
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

    const invoiceId = asString(body.invoiceId || body.id);
    const action = normalizeAction(body.action);
    if (!invoiceId) {
      context.res = json(400, { ok: false, error: "invoiceId is required." });
      return;
    }
    if (!action) {
      context.res = json(400, { ok: false, error: "action must be `pay`." });
      return;
    }

    const now = new Date().toISOString();
    const stage = "accepted";
    await client.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey: invoiceId,
        invoiceId,
        action,
        stage,
        invoiceNumber: asString(body.invoiceNumber),
        customerName: asString(body.customerName),
        vehicle: asString(body.vehicle),
        businessName: asString(body.businessName),
        paymentAmount: sanitizeAmount(body.paymentAmount),
        paymentProvider: asString(body.paymentProvider).toLowerCase(),
        paymentTransactionId: asString(body.paymentTransactionId),
        paymentAccountNumber: maskCardLast4(body.paymentAccountNumber),
        updatedAt: now
      },
      "Merge"
    );

    const notificationsCreated = await createInvoicePaidNotifications(notificationClient, userClient, tenantId, {
      invoiceId,
      invoiceNumber: asString(body.invoiceNumber),
      customerName: asString(body.customerName),
      paymentKind: asString(body.paymentKind),
      lineItems: body.lineItems,
      actor
    });

    context.res = json(200, {
      ok: true,
      tenantId,
      invoiceId,
      action,
      stage,
      updatedAt: now,
      notificationsCreated
    });
  } catch (err) {
    context.log.error(err);
    context.res = json(500, {
      ok: false,
      error: "Server error.",
      detail: String((err && err.message) || err)
    });
  }
};
