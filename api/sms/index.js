const { SmsClient } = require("@azure/communication-sms");
const { TableClient, isSqlBackendEnabled } = require("../_shared/table-client");
const { randomUUID } = require("crypto");
const { resolveTenantId, sanitizeTenantId } = require("../_shared/tenant");
const { requirePrincipal } = require("../_shared/auth");

const SMS_TABLE = "smsmessages";
const SENDER_TABLE = "smssenders";
const CUSTOMERS_TABLE = "customers";
const LOOKUP_PARTITION = "lookup";
const SENDER_DEFAULT_ROW_KEY = "default";

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asBool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
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

function logInfo(context, ...args) {
  if (typeof context.log === "function") {
    context.log(...args);
    return;
  }
  if (context.log && typeof context.log.info === "function") {
    context.log.info(...args);
  }
}

function logError(context, ...args) {
  if (context.log && typeof context.log.error === "function") {
    context.log.error(...args);
    return;
  }
  logInfo(context, ...args);
}

function readHeader(headers, key) {
  if (!headers || typeof headers !== "object") return "";
  const direct = headers[key];
  if (direct != null) return asString(direct);
  const target = String(key || "").toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (String(name || "").toLowerCase() === target) return asString(value);
  }
  return "";
}

function queryParam(req, key) {
  if (req && req.query && req.query[key] != null) return asString(req.query[key]);
  const url = asString(req && req.url);
  if (!url || url.indexOf("?") < 0) return "";
  try {
    const parsed = new URL(url, "http://localhost");
    return asString(parsed.searchParams.get(key));
  } catch {
    return "";
  }
}

function escapedFilterValue(value) {
  return asString(value).replace(/'/g, "''");
}

function getMode() {
  const raw = asString(process.env.SMS_MODE).toLowerCase();
  if (raw === "azure") return "azure";
  return "mock";
}

function normalizeE164(value) {
  const digits = asString(value).replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return "";
}

function isE164(phone) {
  return /^\+[1-9]\d{7,14}$/.test(asString(phone));
}

function phoneLookupKey(value) {
  return normalizeE164(value).replace(/\D+/g, "");
}

function normalizeCustomerPhone(value) {
  const digits = asString(value).replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

function inboundKeywordCategory(message) {
  const keyword = asString(message).toUpperCase();
  if (!keyword) return { category: "", keyword: "" };
  if (["START", "UNSTOP", "YES", "Y"].includes(keyword)) {
    return { category: "opt-in", keyword };
  }
  if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(keyword)) {
    return { category: "opt-out", keyword };
  }
  if (keyword === "HELP") {
    return { category: "help", keyword };
  }
  return { category: "", keyword };
}

function normalizeDeliveryStatus(rawStatus, direction, simulated) {
  if (asString(direction).toLowerCase() === "inbound") return "received";
  if (asBool(simulated)) return "delivered";

  const raw = asString(rawStatus).toLowerCase();
  if (!raw) return "queued";
  if (raw.includes("deliver")) return "delivered";
  if (raw.includes("fail") || raw.includes("reject") || raw.includes("undeliver") || raw.includes("expire")) return "failed";
  if (raw.includes("receive")) return "received";
  if (raw.includes("queue") || raw.includes("sent") || raw.includes("submit") || raw.includes("accept") || raw.includes("out")) return "queued";
  return "unknown";
}

function normalizedSenderFromEntity(entity) {
  if (!entity) return null;
  const fromNumber = asString(entity.fromNumber);
  if (!fromNumber) return null;
  return {
    fromNumber,
    fromLookupKey: asString(entity.fromLookupKey || phoneLookupKey(fromNumber)),
    label: asString(entity.label) || null,
    verificationStatus: asString(entity.verificationStatus) || null,
    enabled: entity.enabled == null ? true : asBool(entity.enabled),
    updatedAt: asString(entity.updatedAt) || null
  };
}

function pickPhone(value) {
  return normalizeE164(asString(value));
}

function firstNonEmpty(values) {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return "";
}

function eventTypeOf(event) {
  return asString(event && (event.eventType || event.type));
}

function eventDataOf(event) {
  const data = event && event.data;
  return data && typeof data === "object" ? data : {};
}

function isEventPayload(bodyRaw) {
  if (Array.isArray(bodyRaw)) {
    return bodyRaw.some(item => !!eventTypeOf(item));
  }
  if (bodyRaw && typeof bodyRaw === "object") {
    return !!eventTypeOf(bodyRaw);
  }
  return false;
}

function webhookAuthorized(req) {
  const expected = asString(process.env.SMS_WEBHOOK_KEY);
  if (!expected) return true;
  const fromQuery = queryParam(req, "key");
  const fromHeader = readHeader(req && req.headers, "x-pathflow-sms-key");
  return !!fromQuery && fromQuery === expected || !!fromHeader && fromHeader === expected;
}

function senderResponseFromConfig(sender, envFrom) {
  const tenantFrom = asString(sender && sender.fromNumber);
  const fallbackEnv = asString(envFrom);
  const source = tenantFrom ? "tenant" : (fallbackEnv ? "env" : "none");
  return {
    fromNumber: tenantFrom || null,
    label: asString(sender && sender.label) || null,
    verificationStatus: asString(sender && sender.verificationStatus) || null,
    enabled: sender ? sender.enabled !== false : true,
    source
  };
}

function getConfigStatus(tenantId, sender) {
  const mode = getMode();
  const hasConnection = !!asString(process.env.ACS_CONNECTION_STRING);
  const envFrom = pickPhone(process.env.ACS_SMS_FROM);
  const tenantFrom = pickPhone(sender && sender.fromNumber);
  const effectiveFrom = tenantFrom || envFrom;
  const hasFromNumber = !!effectiveFrom;
  const readyForLive = mode === "azure" && hasConnection && hasFromNumber;
  return {
    tenantId: sanitizeTenantId(tenantId),
    mode,
    provider: mode === "azure" ? "azure-communication-services" : "mock",
    configured: {
      connectionString: hasConnection,
      fromNumber: hasFromNumber
    },
    fromNumber: effectiveFrom || null,
    readyForLive,
    sender: senderResponseFromConfig(sender, envFrom)
  };
}

function toMessage(entity) {
  const direction = asString(entity.direction).toLowerCase() === "inbound" ? "inbound" : "outbound";
  const deliveryStatus = normalizeDeliveryStatus(entity.deliveryStatus || entity.deliveryStatusRaw, direction, entity.simulated);
  return {
    id: asString(entity.rowKey),
    customerId: asString(entity.customerId) || null,
    customerName: asString(entity.customerName) || null,
    direction,
    from: asString(entity.fromNumber) || null,
    to: asString(entity.toNumber) || null,
    message: asString(entity.message),
    createdAt: asString(entity.createdAt) || new Date().toISOString(),
    read: asBool(entity.read),
    readAt: asString(entity.readAt) || null,
    simulated: asBool(entity.simulated),
    provider: asString(entity.provider) || null,
    providerMessageId: asString(entity.providerMessageId) || null,
    deliveryStatus,
    deliveryStatusRaw: asString(entity.deliveryStatusRaw) || null,
    deliveryUpdatedAt: asString(entity.deliveryUpdatedAt) || null,
    deliveredAt: asString(entity.deliveredAt) || null,
    failedAt: asString(entity.failedAt) || null,
    providerErrorCode: asString(entity.providerErrorCode) || null,
    providerErrorMessage: asString(entity.providerErrorMessage) || null
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

function sortByCreatedAsc(a, b) {
  return sortByCreatedDesc(b, a);
}

function toThreadSummaries(messages) {
  const map = new Map();
  for (const item of messages) {
    const key = asString(item.customerId) || asString(item.from) || asString(item.to) || asString(item.id);
    if (!key) continue;
    const ts = Date.parse(asString(item.createdAt));
    const unread = item.direction === "inbound" && !item.read ? 1 : 0;
    const existing = map.get(key);
    const latestDeliveryStatus = normalizeDeliveryStatus(item.deliveryStatus || item.deliveryStatusRaw, item.direction, item.simulated);
    const latestDeliveryError = asString(item.providerErrorMessage || item.providerErrorCode) || null;
    if (!existing) {
      map.set(key, {
        key,
        customerId: item.customerId || null,
        customerName: item.customerName || null,
        latestMessage: item.message || "",
        latestAt: item.createdAt || new Date().toISOString(),
        latestDirection: item.direction === "inbound" ? "inbound" : "outbound",
        customerPhone: item.direction === "inbound" ? (item.from || null) : (item.to || null),
        latestDeliveryStatus,
        latestDeliveryError,
        unread,
        _latestTs: Number.isFinite(ts) ? ts : 0
      });
      continue;
    }

    existing.unread += unread;
    if (Number.isFinite(ts) && ts >= existing._latestTs) {
      existing._latestTs = ts;
      existing.latestMessage = item.message || "";
      existing.latestAt = item.createdAt || existing.latestAt;
      existing.latestDirection = item.direction === "inbound" ? "inbound" : "outbound";
      existing.customerPhone = item.direction === "inbound" ? (item.from || null) : (item.to || null);
      existing.latestDeliveryStatus = latestDeliveryStatus;
      existing.latestDeliveryError = latestDeliveryError;
      if (item.customerId) existing.customerId = item.customerId;
      if (item.customerName) existing.customerName = item.customerName;
    }
  }

  return Array.from(map.values())
    .sort((a, b) => b._latestTs - a._latestTs)
    .map(item => ({
      key: item.key,
      customerId: item.customerId,
      customerName: item.customerName,
      customerPhone: item.customerPhone,
      latestMessage: item.latestMessage,
      latestAt: item.latestAt,
      latestDirection: item.latestDirection,
      latestDeliveryStatus: item.latestDeliveryStatus,
      latestDeliveryError: item.latestDeliveryError,
      unread: item.unread
    }));
}

async function getTableClient(table) {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn && !isSqlBackendEnabled()) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn, table);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

async function getSmsTableClient() {
  return getTableClient(SMS_TABLE);
}

async function getSenderTableClient() {
  return getTableClient(SENDER_TABLE);
}

async function getCustomersTableClient() {
  return getTableClient(CUSTOMERS_TABLE);
}

async function getTenantSenderConfig(senderClient, tenantId) {
  try {
    const entity = await senderClient.getEntity(tenantId, SENDER_DEFAULT_ROW_KEY);
    return normalizedSenderFromEntity(entity);
  } catch {
    return null;
  }
}

async function setTenantSenderConfig(senderClient, tenantId, body) {
  const fromNumber = pickPhone(body.fromNumber);
  if (!fromNumber) {
    throw new Error("fromNumber must be E.164 format.");
  }

  const now = new Date().toISOString();
  const nextLookupKey = phoneLookupKey(fromNumber);
  const previous = await getTenantSenderConfig(senderClient, tenantId);
  const next = {
    partitionKey: tenantId,
    rowKey: SENDER_DEFAULT_ROW_KEY,
    fromNumber,
    fromLookupKey: nextLookupKey,
    label: asString(body.label),
    verificationStatus: asString(body.verificationStatus || "pending"),
    enabled: true,
    updatedAt: now
  };

  await senderClient.upsertEntity(next, "Merge");
  await senderClient.upsertEntity(
    {
      partitionKey: LOOKUP_PARTITION,
      rowKey: nextLookupKey,
      tenantId,
      fromNumber,
      updatedAt: now
    },
    "Merge"
  );

  const previousLookupKey = asString(previous && previous.fromLookupKey);
  if (previousLookupKey && previousLookupKey !== nextLookupKey) {
    try {
      const lookupEntity = await senderClient.getEntity(LOOKUP_PARTITION, previousLookupKey);
      if (sanitizeTenantId(lookupEntity.tenantId) === tenantId) {
        await senderClient.deleteEntity(LOOKUP_PARTITION, previousLookupKey);
      }
    } catch (_) {}
  }

  return normalizedSenderFromEntity(next);
}

async function clearTenantSenderConfig(senderClient, tenantId) {
  const previous = await getTenantSenderConfig(senderClient, tenantId);
  try {
    await senderClient.deleteEntity(tenantId, SENDER_DEFAULT_ROW_KEY);
  } catch (_) {}

  const previousLookupKey = asString(previous && previous.fromLookupKey);
  if (previousLookupKey) {
    try {
      const lookupEntity = await senderClient.getEntity(LOOKUP_PARTITION, previousLookupKey);
      if (sanitizeTenantId(lookupEntity.tenantId) === tenantId) {
        await senderClient.deleteEntity(LOOKUP_PARTITION, previousLookupKey);
      }
    } catch (_) {}
  }
}

async function ensureTenantSenderBootstrap(senderClient, tenantId, fromNumber) {
  const normalizedFrom = pickPhone(fromNumber);
  if (!normalizedFrom) return;

  const now = new Date().toISOString();
  const fromLookupKey = phoneLookupKey(normalizedFrom);

  let existing = null;
  try {
    existing = await senderClient.getEntity(tenantId, SENDER_DEFAULT_ROW_KEY);
  } catch (_) {}

  await senderClient.upsertEntity(
    {
      partitionKey: tenantId,
      rowKey: SENDER_DEFAULT_ROW_KEY,
      fromNumber: normalizedFrom,
      fromLookupKey,
      label: asString(existing && existing.label),
      verificationStatus: asString(existing && existing.verificationStatus) || "unknown",
      enabled: existing == null ? true : (existing.enabled == null ? true : asBool(existing.enabled)),
      updatedAt: now
    },
    "Merge"
  );

  await senderClient.upsertEntity(
    {
      partitionKey: LOOKUP_PARTITION,
      rowKey: fromLookupKey,
      tenantId,
      fromNumber: normalizedFrom,
      updatedAt: now
    },
    "Merge"
  );
}

async function resolveTenantIdFromSenderNumber(senderClient, number) {
  const key = phoneLookupKey(number);
  if (!key) return "";
  try {
    const entity = await senderClient.getEntity(LOOKUP_PARTITION, key);
    return sanitizeTenantId(entity.tenantId);
  } catch {
    return "";
  }
}

async function resolveTenantFromSenderConfig(senderClient, number) {
  const key = phoneLookupKey(number);
  if (!key) return "";

  const safeKey = escapedFilterValue(key);
  const iter = senderClient.listEntities({
    queryOptions: {
      filter: `fromLookupKey eq '${safeKey}'`
    }
  });

  for await (const entity of iter) {
    const partition = sanitizeTenantId(asString(entity.partitionKey));
    if (!partition || partition === LOOKUP_PARTITION) continue;

    try {
      await senderClient.upsertEntity(
        {
          partitionKey: LOOKUP_PARTITION,
          rowKey: key,
          tenantId: partition,
          fromNumber: asString(entity.fromNumber),
          updatedAt: new Date().toISOString()
        },
        "Merge"
      );
    } catch (_) {}

    return partition;
  }

  return "";
}

async function resolveTenantFromIncomingNumber(senderClient, number) {
  const mappedTenantId = await resolveTenantIdFromSenderNumber(senderClient, number);
  if (mappedTenantId) return mappedTenantId;

  const senderConfigTenantId = await resolveTenantFromSenderConfig(senderClient, number);
  if (senderConfigTenantId) return senderConfigTenantId;
  return "";
}

async function listAllMessages(client, tenantId) {
  const out = [];
  const safeTenant = escapedFilterValue(tenantId);
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${safeTenant}'` } });
  for await (const entity of iter) {
    out.push(toMessage(entity));
  }
  return out;
}

async function saveMessage(client, tenantId, payload) {
  const now = new Date().toISOString();
  const id = asString(payload.id) || randomUUID();
  const createdAt = asString(payload.createdAt) || now;
  const direction = asString(payload.direction).toLowerCase() === "inbound" ? "inbound" : "outbound";
  const deliveryStatus = normalizeDeliveryStatus(payload.deliveryStatus || payload.deliveryStatusRaw, direction, payload.simulated);
  const deliveryUpdatedAt = asString(payload.deliveryUpdatedAt) || now;
  await client.upsertEntity(
    {
      partitionKey: tenantId,
      rowKey: id,
      customerId: asString(payload.customerId),
      customerName: asString(payload.customerName),
      direction,
      fromNumber: asString(payload.from),
      toNumber: asString(payload.to),
      message: asString(payload.message),
      createdAt,
      read: asBool(payload.read),
      readAt: asString(payload.readAt),
      simulated: asBool(payload.simulated),
      provider: asString(payload.provider),
      providerMessageId: asString(payload.providerMessageId),
      deliveryStatus,
      deliveryStatusRaw: asString(payload.deliveryStatusRaw),
      deliveryUpdatedAt,
      deliveredAt: asString(payload.deliveredAt),
      failedAt: asString(payload.failedAt),
      providerErrorCode: asString(payload.providerErrorCode),
      providerErrorMessage: asString(payload.providerErrorMessage),
      updatedAt: now
    },
    "Merge"
  );
  return { id, createdAt, deliveryStatus };
}

function customerNameFromEntity(entity) {
  const firstName = asString(entity && entity.firstName);
  const lastName = asString(entity && entity.lastName);
  const explicitName = asString(entity && entity.name);
  return explicitName || `${firstName} ${lastName}`.trim() || "Customer";
}

function customerPhoneFromEntity(entity) {
  return pickPhone(asString(entity && entity.phone));
}

async function findCustomerById(customersClient, tenantId, customerId) {
  const id = asString(customerId);
  if (!id) return null;
  try {
    const entity = await customersClient.getEntity(tenantId, id);
    return {
      id,
      name: customerNameFromEntity(entity),
      phone: customerPhoneFromEntity(entity)
    };
  } catch {
    return null;
  }
}

async function hydrateMessagesWithCustomerData(customersClient, tenantId, messages) {
  if (!Array.isArray(messages) || !messages.length) return;
  const cache = new Map();
  for (const item of messages) {
    const customerId = asString(item && item.customerId);
    if (!customerId) continue;

    if (!cache.has(customerId)) {
      cache.set(customerId, await findCustomerById(customersClient, tenantId, customerId));
    }
    const customer = cache.get(customerId);
    if (!customer) continue;

    if (!asString(item.customerName) && customer.name) {
      item.customerName = customer.name;
    }
    if (asString(item.direction).toLowerCase() === "inbound" && !asString(item.from) && customer.phone) {
      item.from = customer.phone;
    }
    if (asString(item.direction).toLowerCase() === "outbound" && !asString(item.to) && customer.phone) {
      item.to = customer.phone;
    }
  }
}

async function markRead(client, tenantId, id) {
  const itemId = asString(id);
  if (!itemId) return false;
  try {
    await client.getEntity(tenantId, itemId);
  } catch {
    return false;
  }
  await client.upsertEntity(
    {
      partitionKey: tenantId,
      rowKey: itemId,
      read: true,
      readAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    "Merge"
  );
  return true;
}

async function findCustomerByPhone(customersClient, tenantId, phone) {
  const normalized = normalizeCustomerPhone(phone);
  if (!normalized) return null;
  const safeTenant = escapedFilterValue(tenantId);
  const iter = customersClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${safeTenant}'` } });
  for await (const entity of iter) {
    const candidatePhone = normalizeCustomerPhone(entity.phone);
    if (!candidatePhone || candidatePhone !== normalized) continue;
    return {
      id: asString(entity.rowKey),
      name: customerNameFromEntity(entity),
      phone: customerPhoneFromEntity(entity)
    };
  }
  return null;
}

async function resolveTenantFromCustomerPhone(customersClient, phone) {
  const normalized = normalizeCustomerPhone(phone);
  if (!normalized) return "";

  let match = "";
  const iter = customersClient.listEntities();
  for await (const entity of iter) {
    const candidatePhone = normalizeCustomerPhone(entity.phone);
    if (!candidatePhone || candidatePhone !== normalized) continue;

    const tenant = sanitizeTenantId(asString(entity.partitionKey));
    if (!tenant) continue;

    if (!match) {
      match = tenant;
      continue;
    }

    if (match !== tenant) {
      return "";
    }
  }

  return match;
}

async function applyInboundConsentKeyword(customersClient, tenantId, customerId, message, timestamp) {
  const keyword = inboundKeywordCategory(message);
  if (!keyword.category || !customerId) return;
  const when = asString(timestamp) || new Date().toISOString();

  if (keyword.category === "opt-in") {
    await customersClient.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey: customerId,
        smsConsentStatus: "opted-in",
        smsConsentKeyword: keyword.keyword,
        smsConsentConfirmedAt: when,
        smsConsentLastKeywordAt: when,
        smsConsentUpdatedAt: when,
        updatedAt: when
      },
      "Merge"
    );
    return;
  }

  if (keyword.category === "opt-out") {
    await customersClient.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey: customerId,
        smsConsentStatus: "opted-out",
        smsConsentKeyword: keyword.keyword,
        smsConsentRevokedAt: when,
        smsConsentLastKeywordAt: when,
        smsConsentUpdatedAt: when,
        updatedAt: when
      },
      "Merge"
    );
    return;
  }

  if (keyword.category === "help") {
    await customersClient.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey: customerId,
        smsConsentKeyword: keyword.keyword,
        smsConsentLastKeywordAt: when,
        updatedAt: when
      },
      "Merge"
    );
  }
}

async function resolveTenantByProviderMessageId(smsClient, providerMessageId) {
  const safeMessageId = escapedFilterValue(providerMessageId);
  const iter = smsClient.listEntities({
    queryOptions: {
      filter: `providerMessageId eq '${safeMessageId}'`
    }
  });

  let match = "";
  for await (const entity of iter) {
    const tenant = sanitizeTenantId(asString(entity.partitionKey));
    if (!tenant) continue;

    if (!match) {
      match = tenant;
      continue;
    }

    if (match !== tenant) {
      return "";
    }
  }

  return match;
}

async function resolveTenantFromSmsHistoryBySenderNumber(smsClient, senderNumber) {
  const normalizedSender = pickPhone(senderNumber);
  if (!normalizedSender) return "";

  const safeSender = escapedFilterValue(normalizedSender);
  const iter = smsClient.listEntities({
    queryOptions: {
      filter: `fromNumber eq '${safeSender}' and direction eq 'outbound'`
    }
  });

  let bestTenant = "";
  let bestTs = Number.NEGATIVE_INFINITY;
  for await (const entity of iter) {
    const tenant = sanitizeTenantId(asString(entity.partitionKey));
    if (!tenant) continue;

    const ts = Date.parse(asString(entity.createdAt));
    const score = Number.isFinite(ts) ? ts : 0;
    if (score >= bestTs) {
      bestTs = score;
      bestTenant = tenant;
    }
  }

  return bestTenant;
}

async function updateMessagesByProviderMessageId(client, tenantId, providerMessageId, patch) {
  const safeTenant = escapedFilterValue(tenantId);
  const safeProviderMessageId = escapedFilterValue(providerMessageId);
  const iter = client.listEntities({
    queryOptions: {
      filter: `PartitionKey eq '${safeTenant}' and providerMessageId eq '${safeProviderMessageId}'`
    }
  });

  let updated = 0;
  const now = new Date().toISOString();
  for await (const entity of iter) {
    await client.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey: asString(entity.rowKey),
        ...patch,
        updatedAt: now
      },
      "Merge"
    );
    updated += 1;
  }
  return updated;
}

function extractWebhookEvents(bodyRaw) {
  if (Array.isArray(bodyRaw)) return bodyRaw;
  if (bodyRaw && typeof bodyRaw === "object") return [bodyRaw];
  return [];
}

function buildSubscriptionValidationResponse(events) {
  for (const event of events) {
    const type = eventTypeOf(event).toLowerCase();
    if (!type.includes("subscriptionvalidationevent")) continue;
    const data = eventDataOf(event);
    const validationCode = asString(data.validationCode);
    if (validationCode) return { validationResponse: validationCode };
  }
  return null;
}

async function processInboundEvent(senderClient, smsClient, customersClient, event) {
  const data = eventDataOf(event);
  const toNumber = pickPhone(firstNonEmpty([
    data.to,
    data.toPhoneNumber,
    data.destinationPhoneNumber,
    data.recipient,
    data.phoneNumber
  ]));
  const fromNumber = pickPhone(firstNonEmpty([
    data.from,
    data.fromPhoneNumber,
    data.sender,
    data.originator
  ]));
  const message = asString(firstNonEmpty([data.message, data.text, data.content]));
  if (!toNumber || !message) return false;

  let tenantId = await resolveTenantFromIncomingNumber(senderClient, toNumber);
  if (!tenantId) {
    tenantId = await resolveTenantFromSmsHistoryBySenderNumber(smsClient, toNumber);
  }
  if (!tenantId && fromNumber) {
    tenantId = await resolveTenantFromCustomerPhone(customersClient, fromNumber);
  }
  if (!tenantId) {
    const normalizedIncoming = pickPhone(toNumber);
    const normalizedEnvSender = pickPhone(process.env.ACS_SMS_FROM);
    if (normalizedIncoming && normalizedEnvSender && normalizedIncoming === normalizedEnvSender) {
      tenantId = sanitizeTenantId(asString(process.env.DEFAULT_TENANT_ID) || "main");
    }
  }
  if (!tenantId) return false;

  const customer = await findCustomerByPhone(customersClient, tenantId, fromNumber);
  const providerMessageId = asString(firstNonEmpty([data.messageId, data.id, event.id]));
  const createdAt = asString(firstNonEmpty([data.receivedTimestamp, data.receivedOn, event.time, event.eventTime])) || new Date().toISOString();
  if (customer && customer.id) {
    await applyInboundConsentKeyword(customersClient, tenantId, customer.id, message, createdAt);
  }
  await saveMessage(smsClient, tenantId, {
    customerId: customer ? customer.id : "",
    customerName: customer ? customer.name : "",
    direction: "inbound",
    from: fromNumber,
    to: toNumber,
    message,
    createdAt,
    read: false,
    readAt: "",
    simulated: false,
    provider: "azure-communication-services",
    providerMessageId,
    deliveryStatus: "received",
    deliveryStatusRaw: asString(eventTypeOf(event)),
    deliveryUpdatedAt: createdAt,
    deliveredAt: "",
    failedAt: "",
    providerErrorCode: "",
    providerErrorMessage: ""
  });
  return true;
}

async function processDeliveryEvent(senderClient, smsClient, event) {
  const data = eventDataOf(event);
  const providerMessageId = asString(firstNonEmpty([data.messageId, data.id, data.smsMessageId]));
  const senderNumber = pickPhone(firstNonEmpty([
    data.from,
    data.fromPhoneNumber,
    data.sender
  ]));
  const fallbackNumber = pickPhone(firstNonEmpty([
    data.to,
    data.toPhoneNumber,
    data.destinationPhoneNumber
  ]));
  let tenantId = await resolveTenantFromIncomingNumber(senderClient, senderNumber || fallbackNumber);
  if (!tenantId && providerMessageId) {
    tenantId = await resolveTenantByProviderMessageId(smsClient, providerMessageId);
  }
  if (!tenantId) {
    const candidate = senderNumber || fallbackNumber;
    const normalizedIncoming = pickPhone(candidate);
    const normalizedEnvSender = pickPhone(process.env.ACS_SMS_FROM);
    if (normalizedIncoming && normalizedEnvSender && normalizedIncoming === normalizedEnvSender) {
      tenantId = sanitizeTenantId(asString(process.env.DEFAULT_TENANT_ID) || "main");
    }
  }
  if (!tenantId) return 0;
  if (!providerMessageId) return 0;

  const rawStatus = asString(firstNonEmpty([
    data.deliveryStatus,
    data.status,
    data.deliveryState,
    data.state
  ]));
  const deliveryStatus = normalizeDeliveryStatus(rawStatus, "outbound", false);
  const timestamp = asString(firstNonEmpty([data.receivedTimestamp, data.timestamp, event.time, event.eventTime])) || new Date().toISOString();
  const errorCode = asString(firstNonEmpty([data.errorCode, data.code]));
  const errorMessage = asString(firstNonEmpty([
    data.errorMessage,
    data.deliveryStatusDetails,
    data.statusDetails
  ]));
  return updateMessagesByProviderMessageId(smsClient, tenantId, providerMessageId, {
    deliveryStatus,
    deliveryStatusRaw: rawStatus,
    deliveryUpdatedAt: timestamp,
    deliveredAt: deliveryStatus === "delivered" ? timestamp : "",
    failedAt: deliveryStatus === "failed" ? timestamp : "",
    providerErrorCode: errorCode,
    providerErrorMessage: errorMessage
  });
}

async function handleWebhook(context, req, bodyRaw) {
  if (!webhookAuthorized(req)) {
    context.res = json(401, { error: "Unauthorized webhook request." });
    return;
  }

  const events = extractWebhookEvents(bodyRaw);
  if (!events.length) {
    context.res = json(400, { error: "Webhook payload must contain one or more events." });
    return;
  }

  const validation = buildSubscriptionValidationResponse(events);
  if (validation) {
    context.res = json(200, validation);
    return;
  }

  const senderClient = await getSenderTableClient();
  const smsClient = await getSmsTableClient();
  const customersClient = await getCustomersTableClient();

  let inboundProcessed = 0;
  let deliveryEvents = 0;
  let deliveryUpdated = 0;
  let ignored = 0;
  let errors = 0;

  for (const event of events) {
    const type = eventTypeOf(event).toLowerCase();
    try {
      if (type.includes("smsreceived")) {
        const ok = await processInboundEvent(senderClient, smsClient, customersClient, event);
        if (ok) inboundProcessed += 1;
        else ignored += 1;
        continue;
      }

      if (type.includes("smsdeliveryreportreceived") || type.includes("deliveryreport")) {
        deliveryEvents += 1;
        deliveryUpdated += await processDeliveryEvent(senderClient, smsClient, event);
        continue;
      }

      ignored += 1;
    } catch (err) {
      errors += 1;
      logError(context, "[sms][webhook][error]", err);
    }
  }

  context.res = json(200, {
    ok: true,
    webhook: true,
    inboundProcessed,
    deliveryEvents,
    deliveryUpdated,
    ignored,
    errors
  });
}

module.exports = async function (context, req) {
  const method = asString(req.method || "GET").toUpperCase();
  const bodyRaw = req && req.body;
  const body = asObject(bodyRaw);

  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }

  const scope = queryParam(req, "scope").toLowerCase();
  const op = asString(body.op || body.operation || body.action).toLowerCase();

  if (method === "POST" && (scope === "webhook" || op === "webhook" || readHeader(req && req.headers, "aeg-event-type") || isEventPayload(bodyRaw))) {
    try {
      await handleWebhook(context, req, bodyRaw);
    } catch (err) {
      logError(context, err);
      context.res = json(500, {
        error: "Webhook processing error",
        detail: String((err && err.message) || err)
      });
    }
    return;
  }
  const principal = await requirePrincipal(context, req);
  if (!principal) return;

  const tenantId = resolveTenantId(req, body);

  try {
    const smsTable = await getSmsTableClient();
    const senderTable = await getSenderTableClient();
    const customersTable = await getCustomersTableClient();
    const senderConfig = await getTenantSenderConfig(senderTable, tenantId);
    const status = getConfigStatus(tenantId, senderConfig);

    if (method === "GET") {
      if (!scope) {
        context.res = json(200, {
          ok: true,
          ...status
        });
        return;
      }

      if (scope === "sender") {
        context.res = json(200, {
          ok: true,
          tenantId,
          sender: status.sender
        });
        return;
      }

      const all = await listAllMessages(smsTable, tenantId);
      await hydrateMessagesWithCustomerData(customersTable, tenantId, all);
      const rawLimit = Number(queryParam(req, "limit"));
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 0;

      if (scope === "inbox") {
        let items = all
          .filter(item => item.direction === "inbound" && !item.read)
          .sort(sortByCreatedDesc);
        if (limit > 0) items = items.slice(0, limit);
        context.res = json(200, { ok: true, tenantId, scope, items });
        return;
      }

      if (scope === "customer") {
        const customerId = queryParam(req, "customerId");
        if (!customerId) {
          context.res = json(400, { error: "customerId is required for scope=customer." });
          return;
        }
        let items = all
          .filter(item => item.customerId === customerId)
          .sort(sortByCreatedAsc);
        if (limit > 0) items = items.slice(Math.max(0, items.length - limit));
        context.res = json(200, { ok: true, tenantId, scope, customerId, items });
        return;
      }

      if (scope === "threads") {
        let items = toThreadSummaries(all);
        if (limit > 0) items = items.slice(0, limit);
        context.res = json(200, { ok: true, tenantId, scope, items });
        return;
      }

      context.res = json(400, { error: "Unknown scope. Use `inbox`, `customer`, `threads`, or `sender`." });
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { error: "Method not allowed" });
      return;
    }

    if (op === "setsenderconfig" || op === "set-sender-config") {
      const sender = await setTenantSenderConfig(senderTable, tenantId, body);
      const nextStatus = getConfigStatus(tenantId, sender);
      context.res = json(200, {
        ok: true,
        tenantId,
        sender: nextStatus.sender
      });
      return;
    }

    if (op === "clearsenderconfig" || op === "clear-sender-config") {
      await clearTenantSenderConfig(senderTable, tenantId);
      const nextStatus = getConfigStatus(tenantId, null);
      context.res = json(200, {
        ok: true,
        tenantId,
        sender: nextStatus.sender
      });
      return;
    }

    if (op === "markread" || op === "mark-read") {
      const id = asString(body.id);
      if (!id) {
        context.res = json(400, { error: "id is required for markRead." });
        return;
      }

      const ok = await markRead(smsTable, tenantId, id);
      if (!ok) {
        context.res = json(404, { error: "Message not found." });
        return;
      }

      context.res = json(200, { ok: true, tenantId, id });
      return;
    }

    if (op === "markreadbatch" || op === "mark-read-batch") {
      const ids = Array.isArray(body.ids) ? body.ids.map(asString).filter(Boolean) : [];
      if (!ids.length) {
        context.res = json(400, { error: "ids is required for markReadBatch." });
        return;
      }

      let updated = 0;
      for (const id of ids) {
        try {
          const ok = await markRead(smsTable, tenantId, id);
          if (ok) updated += 1;
        } catch (_) {}
      }

      context.res = json(200, { ok: true, tenantId, updated });
      return;
    }

    const requestTo = asString(body.to);
    const requestMessage = asString(body.message);
    const requestCustomerId = asString(body.customerId);
    const requestCustomerName = asString(body.customerName);
    const requestDirection = asString(body.direction).toLowerCase();
    const inboundHint = requestDirection === "inbound" || asBool(body.inbound);
    const inferredInbound = !!requestCustomerId &&
      !!requestMessage &&
      !requestTo &&
      (!op || inboundHint || op.indexOf("incoming") >= 0 || op.indexOf("inbound") >= 0);

    if (op === "logincoming" || op === "log-incoming" || inferredInbound) {
      const message = requestMessage;
      const customerId = requestCustomerId;
      if (!message) {
        context.res = json(400, { error: "message is required for logIncoming." });
        return;
      }
      if (!customerId) {
        context.res = json(400, { error: "customerId is required for logIncoming." });
        return;
      }

      const customerRecord = await findCustomerById(customersTable, tenantId, customerId);
      const customerName = requestCustomerName || asString(customerRecord && customerRecord.name);
      const customerPhone = asString(body.from) || asString(customerRecord && customerRecord.phone);

      const saved = await saveMessage(smsTable, tenantId, {
        customerId,
        customerName,
        direction: "inbound",
        from: customerPhone,
        to: status.fromNumber || "",
        message,
        read: false,
        readAt: "",
        simulated: true,
        provider: "manual",
        providerMessageId: "",
        deliveryStatus: "received",
        deliveryStatusRaw: "manual",
        deliveryUpdatedAt: new Date().toISOString(),
        deliveredAt: "",
        failedAt: "",
        providerErrorCode: "",
        providerErrorMessage: ""
      });
      await applyInboundConsentKeyword(customersTable, tenantId, customerId, message, saved.createdAt);

      context.res = json(200, {
        ok: true,
        tenantId,
        mode: getMode(),
        provider: "manual",
        simulated: true,
        direction: "inbound",
        id: saved.id,
        createdAt: saved.createdAt,
        deliveryStatus: saved.deliveryStatus
      });
      return;
    }

    const to = requestTo;
    const message = requestMessage;
    const customerId = requestCustomerId;
    const customerName = requestCustomerName;

    if (!to || !message) {
      context.res = json(400, { error: "`to` and `message` are required." });
      return;
    }
    if (!isE164(to)) {
      context.res = json(400, { error: "Phone must use E.164 format (example: +15551234567)." });
      return;
    }
    if (message.length > 1000) {
      context.res = json(400, { error: "Message is too long (max 1000 characters in this endpoint)." });
      return;
    }

    let simulated = true;
    let providerMessageId = "";
    let provider = status.provider;
    let deliveryStatus = "delivered";
    let deliveryStatusRaw = "mock";
    let providerErrorCode = "";
    let providerErrorMessage = "";

    if (status.mode === "azure") {
      if (!status.readyForLive || !status.fromNumber) {
        context.res = json(500, {
          error: "SMS_MODE is azure but ACS_CONNECTION_STRING or sender number is missing."
        });
        return;
      }

      const client = new SmsClient(asString(process.env.ACS_CONNECTION_STRING));
      const sendResult = await client.send({
        from: status.fromNumber,
        to: [to],
        message
      });

      const first = Array.isArray(sendResult)
        ? sendResult[0]
        : (Array.isArray(sendResult && sendResult.results) ? sendResult.results[0] : sendResult);
      const successful = first && typeof first.successful === "boolean" ? first.successful : true;
      if (!successful) {
        context.res = json(502, {
          error: "Azure SMS provider rejected message.",
          detail: first && (first.errorMessage || first.code || "Unknown provider error")
        });
        return;
      }

      simulated = false;
      providerMessageId = first && first.messageId ? asString(first.messageId) : "";
      provider = "azure-communication-services";
      deliveryStatusRaw = asString(first && (first.deliveryStatus || first.status || "Queued")) || "Queued";
      deliveryStatus = normalizeDeliveryStatus(deliveryStatusRaw, "outbound", false);
      providerErrorCode = asString(first && first.errorCode);
      providerErrorMessage = asString(first && first.errorMessage);
    } else {
      logInfo(context, "[sms][mock] tenant=%s to=%s message=%s", tenantId, to, message);
    }

    await ensureTenantSenderBootstrap(senderTable, tenantId, status.fromNumber);

    const now = new Date().toISOString();
    const saved = await saveMessage(smsTable, tenantId, {
      customerId,
      customerName,
      direction: "outbound",
      from: status.fromNumber || "",
      to,
      message,
      read: true,
      readAt: now,
      simulated,
      provider,
      providerMessageId,
      deliveryStatus,
      deliveryStatusRaw,
      deliveryUpdatedAt: now,
      deliveredAt: deliveryStatus === "delivered" ? now : "",
      failedAt: deliveryStatus === "failed" ? now : "",
      providerErrorCode,
      providerErrorMessage
    });

    context.res = json(200, {
      ok: true,
      tenantId,
      mode: status.mode,
      provider,
      simulated,
      to,
      customerId: customerId || null,
      messageId: providerMessageId || null,
      id: saved.id,
      createdAt: saved.createdAt,
      deliveryStatus: saved.deliveryStatus
    });
  } catch (err) {
    logError(context, err);
    context.res = json(500, {
      error: "Server error",
      detail: String((err && err.message) || err)
    });
  }
};
