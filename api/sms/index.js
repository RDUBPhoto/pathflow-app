const { SmsClient } = require("@azure/communication-sms");
const { TableClient, isSqlBackendEnabled } = require("../_shared/table-client");
const { createHash, randomUUID } = require("crypto");
const { resolveTenantId, sanitizeTenantId } = require("../_shared/tenant");
const { requirePrincipal } = require("../_shared/auth");

const SMS_TABLE = "smsmessages";
const SMS_CONSENTS_TABLE = "smsconsents";
const SENDER_TABLE = "smssenders";
const CUSTOMERS_TABLE = "customers";
const SETTINGS_TABLE = "appsettings";
const BUSINESS_PROFILE_KEY = "business.profile";
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

function isLoopbackRequest(req) {
  const host = (readHeader(req && req.headers, "x-forwarded-host") || readHeader(req && req.headers, "host")).toLowerCase();
  return host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
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

function phoneConsentRowKey(value) {
  const key = phoneLookupKey(value);
  if (!key) return "";
  return `phone-${key}`.slice(0, 220);
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

function isOptedInStatus(value) {
  return ["opted-in", "opted_in", "confirmed", "subscribed"].includes(asString(value).toLowerCase());
}

function isOptedOutStatus(value) {
  return ["opted-out", "opted_out", "unsubscribed", "stopped"].includes(asString(value).toLowerCase());
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

function stableMessageRowKey(direction, providerMessageId) {
  const id = asString(providerMessageId);
  if (!id) return "";
  return String(`sms-${asString(direction) || "message"}-${id}`)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 220);
}

async function messageExists(client, tenantId, id) {
  const rowKey = asString(id);
  if (!rowKey) return false;
  try {
    await client.getEntity(tenantId, rowKey);
    return true;
  } catch {
    return false;
  }
}

async function findRecentInboundDuplicate(client, tenantId, payload) {
  const message = asString(payload && payload.message).toLowerCase();
  const fromKey = phoneLookupKey(payload && payload.from);
  const toKey = phoneLookupKey(payload && payload.to);
  if (!message || !fromKey || !toKey) return null;

  const createdAtMs = Date.parse(asString(payload && payload.createdAt)) || Date.now();
  const safeTenant = escapedFilterValue(tenantId);
  const iter = client.listEntities({
    queryOptions: {
      filter: `PartitionKey eq '${safeTenant}' and direction eq 'inbound'`
    }
  });

  let closest = null;
  let closestDelta = Number.POSITIVE_INFINITY;
  for await (const entity of iter) {
    const existing = toMessage(entity);
    if (asString(existing.message).toLowerCase() !== message) continue;
    if (phoneLookupKey(existing.from) !== fromKey || phoneLookupKey(existing.to) !== toKey) continue;

    const existingAtMs = Date.parse(asString(existing.createdAt));
    if (!Number.isFinite(existingAtMs)) continue;
    const delta = Math.abs(existingAtMs - createdAtMs);
    if (delta > 120000 || delta >= closestDelta) continue;
    closest = existing;
    closestDelta = delta;
  }

  return closest;
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

function firstPhone(values) {
  for (const value of values) {
    const phone = pickPhone(value);
    if (phone) return phone;
  }
  return "";
}

function extractMessageText(data) {
  const source = data && typeof data === "object" ? data : {};
  const candidates = [
    source.message,
    source.text,
    source.content,
    source.messageBody,
    source.body,
    source.smsMessage,
    source.smsMessageContent
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      const nested = firstNonEmpty([
        candidate.message,
        candidate.text,
        candidate.content,
        candidate.body,
        candidate.value
      ]);
      if (nested) return nested;
      continue;
    }
    const text = asString(candidate);
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

function messageDisplayKey(item) {
  const providerId = asString(item && item.providerMessageId);
  const direction = asString(item && item.direction).toLowerCase();
  const createdAtMs = Date.parse(asString(item && item.createdAt));
  const tenMinuteBucket = Number.isFinite(createdAtMs) ? Math.round(createdAtMs / 600000) : "";
  if (direction !== "inbound" && providerId) return `${direction}:provider:${providerId}`;

  return [
    direction,
    asString(item && item.customerId),
    pickPhone(item && item.from),
    pickPhone(item && item.to),
    asString(item && item.message).toLowerCase(),
    tenMinuteBucket
  ].join("|");
}

function chooseDisplayMessage(existing, candidate) {
  if (!existing) return candidate;
  const existingStatus = normalizeDeliveryStatus(existing.deliveryStatus || existing.deliveryStatusRaw, existing.direction, existing.simulated);
  const candidateStatus = normalizeDeliveryStatus(candidate.deliveryStatus || candidate.deliveryStatusRaw, candidate.direction, candidate.simulated);
  if (existingStatus !== "delivered" && candidateStatus === "delivered") return candidate;
  if (existingStatus === "queued" && candidateStatus === "received") return candidate;
  if (asBool(existing.read) && !asBool(candidate.read)) return candidate;
  const existingTs = Date.parse(asString(existing.createdAt));
  const candidateTs = Date.parse(asString(candidate.createdAt));
  if (Number.isFinite(existingTs) && Number.isFinite(candidateTs) && candidateTs < existingTs) return candidate;
  return existing;
}

function dedupeMessagesForDisplay(items) {
  const byKey = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const key = messageDisplayKey(item) || asString(item && item.id);
    if (!key) continue;
    byKey.set(key, chooseDisplayMessage(byKey.get(key), item));
  }
  return Array.from(byKey.values());
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
    const threadPhone = messageConversationPhone(item);
    const phoneKey = phoneLookupKey(threadPhone);
    const key = phoneKey ? `phone:${phoneKey}` : (asString(item.customerId) || asString(item.id));
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
        customerPhone: threadPhone || null,
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
      existing.customerPhone = threadPhone || existing.customerPhone;
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

async function getSettingsTableClient() {
  return getTableClient(SETTINGS_TABLE);
}

async function getSmsConsentsTableClient() {
  return getTableClient(SMS_CONSENTS_TABLE);
}

function customerSafeBrandFallback(value) {
  const brand = asString(value);
  return brand && brand.toLowerCase() !== "pathflow" ? brand : "";
}

function businessNameFromSettingsEntity(entity) {
  const profile = asObject(entity && entity.valueJson);
  return customerSafeBrandFallback(profile && profile.companyName);
}

async function getBusinessBrandName(settingsClient, tenantId) {
  const candidates = [
    tenantId,
    process.env.DEFAULT_TENANT_ID,
    "primary-location",
    "main"
  ]
    .map(value => sanitizeTenantId(value))
    .filter((value, index, all) => value && all.indexOf(value) === index);

  for (const candidate of candidates) {
    try {
      const entity = await settingsClient.getEntity(candidate, BUSINESS_PROFILE_KEY);
      const companyName = businessNameFromSettingsEntity(entity);
      if (companyName) return companyName;
    } catch (_) {}
  }

  return customerSafeBrandFallback(process.env.WIDGET_BRAND_NAME) || "Your service team";
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
  return dedupeMessagesForDisplay(out);
}

async function saveMessage(client, tenantId, payload) {
  const now = new Date().toISOString();
  const createdAt = asString(payload.createdAt) || now;
  const direction = asString(payload.direction).toLowerCase() === "inbound" ? "inbound" : "outbound";
  const deliveryStatus = normalizeDeliveryStatus(payload.deliveryStatus || payload.deliveryStatusRaw, direction, payload.simulated);
  const deliveryUpdatedAt = asString(payload.deliveryUpdatedAt) || now;

  if (direction === "inbound") {
    const duplicate = await findRecentInboundDuplicate(client, tenantId, {
      ...payload,
      createdAt,
      direction
    });
    if (duplicate) {
      return {
        id: duplicate.id,
        createdAt: duplicate.createdAt,
        deliveryStatus: duplicate.deliveryStatus,
        duplicate: true
      };
    }
  }

  const id = asString(payload.id) || randomUUID();
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

function messageConversationPhone(item) {
  const direction = asString(item && item.direction).toLowerCase();
  return direction === "inbound"
    ? firstPhone([item && item.from, item && item.to])
    : firstPhone([item && item.to, item && item.from]);
}

function customerUpdatedTime(entity) {
  const candidates = [
    entity && entity.updatedAt,
    entity && entity.createdAt,
    entity && entity.timestamp
  ];
  for (const value of candidates) {
    const ts = Date.parse(asString(value));
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
}

function normalizedCustomerFromEntity(entity) {
  if (!entity) return null;
  const id = asString(entity.rowKey);
  if (!id) return null;
  return {
    id,
    name: customerNameFromEntity(entity),
    phone: customerPhoneFromEntity(entity),
    phoneKey: phoneLookupKey(entity.phone),
    updatedTs: customerUpdatedTime(entity),
    smsConsentStatus: asString(entity.smsConsentStatus),
    smsConsentConfirmedAt: asString(entity.smsConsentConfirmedAt),
    smsConsentUpdatedAt: asString(entity.smsConsentUpdatedAt),
    smsConsentSource: asString(entity.smsConsentSource)
  };
}

function chooseCanonicalCustomer(current, byPhone) {
  if (!current) return byPhone || null;
  if (!byPhone) return current;
  if (current.id === byPhone.id) return current;
  const currentPhoneKey = phoneLookupKey(current.phone);
  const byPhoneKey = phoneLookupKey(byPhone.phone);
  if (currentPhoneKey && byPhoneKey && currentPhoneKey === byPhoneKey) {
    return (Number(byPhone.updatedTs) || 0) >= (Number(current.updatedTs) || 0) ? byPhone : current;
  }
  return current;
}

async function buildCustomerPhoneIndex(customersClient, tenantId) {
  const out = new Map();
  const safeTenant = escapedFilterValue(tenantId);
  const iter = customersClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${safeTenant}'` } });
  for await (const entity of iter) {
    const customer = normalizedCustomerFromEntity(entity);
    if (!customer || !customer.phoneKey) continue;
    const existing = out.get(customer.phoneKey);
    if (!existing || (Number(customer.updatedTs) || 0) >= (Number(existing.updatedTs) || 0)) {
      out.set(customer.phoneKey, customer);
    }
  }
  return out;
}

async function findCustomerById(customersClient, tenantId, customerId) {
  const id = asString(customerId);
  if (!id) return null;
  try {
    const entity = await customersClient.getEntity(tenantId, id);
    return normalizedCustomerFromEntity(entity);
  } catch {
    return null;
  }
}

async function getPhoneConsent(consentsClient, tenantId, phone) {
  const rowKey = phoneConsentRowKey(phone);
  if (!rowKey) return null;
  try {
    return await consentsClient.getEntity(tenantId, rowKey);
  } catch (_) {
    return null;
  }
}

async function reconcileCustomerPhoneConsent(consentsClient, tenantId, phone, customer) {
  if (!customer || !customer.id || !isOptedInStatus(customer.smsConsentStatus)) return;
  const rowKey = phoneConsentRowKey(phone || customer.phone);
  const phoneE164 = normalizeE164(phone || customer.phone);
  if (!rowKey || !phoneE164) return;

  const existing = await getPhoneConsent(consentsClient, tenantId, phoneE164);
  if (existing && isOptedOutStatus(existing.status)) return;
  if (existing && isOptedInStatus(existing.status)) return;

  const when = asString(customer.smsConsentConfirmedAt || customer.smsConsentUpdatedAt) || new Date().toISOString();
  await consentsClient.upsertEntity(
    {
      partitionKey: tenantId,
      rowKey,
      phoneE164,
      phoneKey: rowKey.replace(/^phone-/, ""),
      status: "opted-in",
      confirmedAt: when,
      revokedAt: "",
      customerId: asString(customer.id),
      customerName: asString(customer.name),
      source: asString(customer.smsConsentSource) || "customer-record",
      updatedAt: new Date().toISOString()
    },
    "Merge"
  );
}

async function hydrateMessagesWithCustomerData(customersClient, tenantId, messages) {
  if (!Array.isArray(messages) || !messages.length) return;
  const cache = new Map();
  const phoneIndex = await buildCustomerPhoneIndex(customersClient, tenantId);
  for (const item of messages) {
    const customerId = asString(item && item.customerId);
    if (customerId && !cache.has(customerId)) {
      cache.set(customerId, await findCustomerById(customersClient, tenantId, customerId));
    }
    const directCustomer = customerId ? cache.get(customerId) : null;
    const messagePhone = messageConversationPhone(item);
    const phoneCustomer = phoneIndex.get(phoneLookupKey(messagePhone));
    const customer = chooseCanonicalCustomer(directCustomer, phoneCustomer);
    if (!customer) continue;

    if (customer.id) {
      item.customerId = customer.id;
    }
    if (customer.name) {
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

async function clearTenantSmsHistory(client, tenantId) {
  const safeTenant = escapedFilterValue(tenantId);
  const rows = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${safeTenant}'` } });
  for await (const entity of iter) {
    rows.push({
      partitionKey: asString(entity.partitionKey),
      rowKey: asString(entity.rowKey)
    });
  }
  let deleted = 0;
  for (const row of rows) {
    if (!row.partitionKey || !row.rowKey) continue;
    try {
      await client.deleteEntity(row.partitionKey, row.rowKey);
      deleted += 1;
    } catch (err) {
      if (err && (err.statusCode === 404 || err.code === "ResourceNotFound")) continue;
      throw err;
    }
  }
  return deleted;
}

async function findCustomerByPhone(customersClient, tenantId, phone) {
  const key = phoneLookupKey(phone);
  if (!key) return null;
  const phoneIndex = await buildCustomerPhoneIndex(customersClient, tenantId);
  return phoneIndex.get(key) || null;
}

async function captureUnknownSmsLead(customers, sms, tenantId, inbound) {
  const phone = normalizeE164(inbound.fromNumber);
  if (!phone || !inbound.id) return;
  const key = createHash("sha256").update(phone).digest("hex").slice(0, 32);
  const customerId = `sms-contact-${key}`;
  const leadId = `sms-lead-${key}`;
  const [lanes, workItems] = await Promise.all([getTableClient("lanes"), getTableClient("workitems")]);
  let leadLane;
  const filter = `PartitionKey eq '${tenantId}'`;
  for await (const lane of lanes.listEntities({ queryOptions: { filter } })) {
    if (lane.stageKey === "lead" || /^leads?$/i.test(asString(lane.name))) {
      leadLane = lane.rowKey;
      break;
    }
  }
  if (!leadLane) {
    leadLane = "sms-intake-leads";
    await lanes.upsertEntity({ partitionKey: tenantId, rowKey: leadLane, stageKey: "lead",
      name: "Leads", isSystem: true, sort: 100 }, "Merge");
  }
  const now = new Date().toISOString();
  const customerName = `SMS inquiry ending ${phone.slice(-4)}`;
  for (const [client, row] of [
    [customers, { rowKey: customerId, name: customerName, phone, email: "", creator: "SMS intake" }],
    [workItems, { rowKey: leadId, laneId: leadLane, title: customerName, customerId, customerName,
      source: "sms", leadSource: "sms", channel: "sms", contactPhone: phone, message: inbound.message }]
  ]) {
    try {
      await client.createEntity({ ...row, partitionKey: tenantId, createdAt: now, updatedAt: now });
    } catch (error) {
      if (error.statusCode !== 409) throw error;
    }
  }
  await sms.upsertEntity({ partitionKey: tenantId, rowKey: inbound.id, customerId, customerName }, "Merge");
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
  if (!keyword.category || !customerId) return keyword;
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
    return keyword;
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
    return keyword;
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
  return keyword;
}

async function upsertPhoneConsent(consentsClient, tenantId, phone, keyword, customer, timestamp) {
  const category = keyword && keyword.category;
  if (category !== "opt-in" && category !== "opt-out") return;
  const rowKey = phoneConsentRowKey(phone);
  const phoneE164 = normalizeE164(phone);
  if (!rowKey || !phoneE164) return;

  const when = asString(timestamp) || new Date().toISOString();
  const status = category === "opt-in" ? "opted-in" : "opted-out";
  const patch = {
    partitionKey: tenantId,
    rowKey,
    phoneE164,
    phoneKey: rowKey.replace(/^phone-/, ""),
    status,
    keyword: asString(keyword.keyword),
    lastKeywordAt: when,
    updatedAt: when,
    source: "sms-webhook",
    customerId: customer && customer.id ? asString(customer.id) : "",
    customerName: customer && customer.name ? asString(customer.name) : ""
  };
  if (category === "opt-in") {
    patch.confirmedAt = when;
    patch.revokedAt = "";
  } else {
    patch.revokedAt = when;
  }

  await consentsClient.upsertEntity(patch, "Merge");
}

function buildConsentKeywordReply(category, brandName) {
  const brand = customerSafeBrandFallback(brandName) || "Your service team";
  if (category === "opt-in") {
    return `${brand}: Thank you, your SMS updates are confirmed. We can now text you about your service request. Reply STOP to opt out, HELP for help.`;
  }
  if (category === "opt-out") {
    return `${brand}: You're opted out and will no longer receive SMS updates. Reply START to opt back in.`;
  }
  if (category === "help") {
    return `${brand}: Help is available from your service team. Reply STOP to opt out, START to opt in. Msg&data rates may apply.`;
  }
  return "";
}

async function sendKeywordAutoReply(context, senderClient, smsClient, settingsClient, tenantId, inbound) {
  const keyword = inboundKeywordCategory(inbound && inbound.message);
  if (!keyword.category) return null;
  const replyMessage = buildConsentKeywordReply(keyword.category, await getBusinessBrandName(settingsClient, tenantId));
  const to = pickPhone(inbound && inbound.fromNumber);
  const from = pickPhone(inbound && inbound.toNumber);
  if (!replyMessage || !to || !from) throw new Error("Keyword auto-reply is missing a valid sender or recipient number.");

  const senderConfig = await getTenantSenderConfig(senderClient, tenantId);
  const status = getConfigStatus(tenantId, senderConfig);
  if (status.mode === "azure" && !status.readyForLive) {
    throw new Error("Live SMS is not configured for keyword auto-replies.");
  }
  let simulated = true;
  let providerMessageId = "";
  let provider = status.provider;
  let deliveryStatus = "delivered";
  let deliveryStatusRaw = "keyword-auto-reply";
  let providerErrorCode = "";
  let providerErrorMessage = "";

  if (status.mode === "azure" && status.readyForLive) {
    const client = new SmsClient(asString(process.env.ACS_CONNECTION_STRING));
    const sendResult = await client.send({
      from,
      to: [to],
      message: replyMessage
    }, {
      enableDeliveryReport: true,
      tag: `keyword:${tenantId}`.slice(0, 256)
    });
    const first = Array.isArray(sendResult)
      ? sendResult[0]
      : (Array.isArray(sendResult && sendResult.results) ? sendResult.results[0] : sendResult);
    const successful = first && typeof first.successful === "boolean" ? first.successful : true;
    if (!successful) {
      const reason = asString(first && (first.errorMessage || first.errorCode || first.code)) || "Unknown provider error";
      logError(context, "[sms][keyword-auto-reply][provider-rejected]", reason);
      throw new Error(`Keyword auto-reply rejected by SMS provider: ${reason}`);
    }
    simulated = false;
    providerMessageId = first && first.messageId ? asString(first.messageId) : "";
    provider = "azure-communication-services";
    deliveryStatusRaw = asString(first && (first.deliveryStatus || first.status || "Queued")) || "Queued";
    deliveryStatus = normalizeDeliveryStatus(deliveryStatusRaw, "outbound", false);
    providerErrorCode = asString(first && first.errorCode);
    providerErrorMessage = asString(first && first.errorMessage);
  } else {
    logInfo(context, "[sms][keyword-auto-reply][mock] tenant=%s to=%s message=%s", tenantId, to, replyMessage);
  }

  const now = new Date().toISOString();
  const saved = await saveMessage(smsClient, tenantId, {
    id: asString(inbound && inbound.replyId),
    customerId: asString(inbound && inbound.customerId),
    customerName: asString(inbound && inbound.customerName),
    direction: "outbound",
    from,
    to,
    message: replyMessage,
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

  return {
    id: saved.id,
    providerMessageId,
    deliveryStatus: saved.deliveryStatus,
    simulated
  };
}

async function sendAndRecordKeywordReply(context, senderClient, smsClient, settingsClient, tenantId, inboundId, inbound) {
  const keyword = inboundKeywordCategory(inbound && inbound.message);
  if (!keyword.category) return null;

  const replyId = stableMessageRowKey("keyword-reply", inboundId);
  if (replyId && await messageExists(smsClient, tenantId, replyId)) {
    await smsClient.upsertEntity({
      partitionKey: tenantId,
      rowKey: inboundId,
      keywordReplyStatus: "sent",
      keywordReplyId: replyId,
      keywordReplyError: "",
      keywordReplyUpdatedAt: new Date().toISOString()
    }, "Merge");
    return { id: replyId, deliveryStatus: "queued", simulated: false };
  }

  try {
    const reply = await sendKeywordAutoReply(context, senderClient, smsClient, settingsClient, tenantId, {
      ...inbound,
      replyId
    });
    if (!reply) throw new Error("Keyword auto-reply was not created.");
    await smsClient.upsertEntity({
      partitionKey: tenantId,
      rowKey: inboundId,
      keywordReplyStatus: "sent",
      keywordReplyId: reply.id,
      keywordReplyError: "",
      keywordReplyUpdatedAt: new Date().toISOString()
    }, "Merge");
    return reply;
  } catch (err) {
    try {
      await smsClient.upsertEntity({
        partitionKey: tenantId,
        rowKey: inboundId,
        keywordReplyStatus: "failed",
        keywordReplyError: asString(err && err.message).slice(0, 500),
        keywordReplyUpdatedAt: new Date().toISOString()
      }, "Merge");
    } catch (recordError) {
      logError(context, "[sms][keyword-auto-reply][record-failed]", recordError);
    }
    throw err;
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

async function resolveTenantForInboundMessage(senderClient, smsClient, customersClient, toNumber, fromNumber) {
  const senderTenantId = await resolveTenantFromIncomingNumber(senderClient, toNumber);
  if (senderTenantId) return senderTenantId;

  if (fromNumber) {
    const customerTenantId = await resolveTenantFromCustomerPhone(customersClient, fromNumber);
    if (customerTenantId) return customerTenantId;
  }

  const historyTenantId = await resolveTenantFromSmsHistoryBySenderNumber(smsClient, toNumber);
  if (historyTenantId) return historyTenantId;

  const normalizedIncoming = pickPhone(toNumber);
  const normalizedEnvSender = pickPhone(process.env.ACS_SMS_FROM);
  if (normalizedIncoming && normalizedEnvSender && normalizedIncoming === normalizedEnvSender) {
    return sanitizeTenantId(asString(process.env.DEFAULT_TENANT_ID) || "main");
  }

  return "";
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

async function processInboundEvent(context, senderClient, smsClient, customersClient, settingsClient, consentsClient, event) {
  const data = eventDataOf(event);
  const eventType = eventTypeOf(event);
  const providerMessageId = asString(firstNonEmpty([data.messageId, data.id, event.id]));
  const toNumber = firstPhone([
    data.to,
    data.toPhoneNumber,
    data.destinationPhoneNumber,
    data.receiver,
    data.receiverPhoneNumber,
    data.recipient,
    data.recipientPhoneNumber,
    data.phoneNumber
  ]);
  const fromNumber = firstPhone([
    data.from,
    data.fromPhoneNumber,
    data.senderPhoneNumber,
    data.sender,
    data.originator,
    data.originatorPhoneNumber
  ]);
  const message = extractMessageText(data);
  if (!toNumber || !message) {
    logInfo(
      context,
      "[sms][webhook][ignored-inbound] missing required fields type=%s to=%s from=%s hasMessage=%s dataKeys=%s",
      eventType,
      toNumber ? "yes" : "no",
      fromNumber ? "yes" : "no",
      message ? "yes" : "no",
      Object.keys(data || {}).join(",")
    );
    return {
      processed: false,
      reason: "missing-required-fields",
      eventType,
      providerMessageId,
      hasToNumber: !!toNumber,
      hasFromNumber: !!fromNumber,
      hasMessage: !!message,
      dataKeys: Object.keys(data || {})
    };
  }

  const tenantId = await resolveTenantForInboundMessage(senderClient, smsClient, customersClient, toNumber, fromNumber);
  if (!tenantId) {
    logInfo(
      context,
      "[sms][webhook][ignored-inbound] tenant unresolved type=%s to=%s from=%s messageId=%s",
      eventType,
      toNumber || "",
      fromNumber || "",
      providerMessageId
    );
    return {
      processed: false,
      reason: "tenant-unresolved",
      eventType,
      providerMessageId,
      hasToNumber: !!toNumber,
      hasFromNumber: !!fromNumber,
      hasMessage: !!message
    };
  }

  const inboundRowKey = stableMessageRowKey("inbound", providerMessageId);
  let existingInbound = null;
  if (inboundRowKey) {
    try { existingInbound = await smsClient.getEntity(tenantId, inboundRowKey); } catch (_) {}
  }
  if (existingInbound) {
    const existingKeyword = inboundKeywordCategory(asString(existingInbound.message) || message);
    if (!existingKeyword.category && !asString(existingInbound.customerId)) {
      await captureUnknownSmsLead(customersClient, smsClient, tenantId, { id: inboundRowKey, fromNumber, message });
    }
    let autoReply = null;
    if (existingKeyword.category && asString(existingInbound.keywordReplyStatus) !== "sent") {
      autoReply = await sendAndRecordKeywordReply(context, senderClient, smsClient, settingsClient, tenantId, inboundRowKey, {
        customerId: asString(existingInbound.customerId),
        customerName: asString(existingInbound.customerName),
        fromNumber: asString(existingInbound.fromNumber) || fromNumber,
        toNumber: asString(existingInbound.toNumber) || toNumber,
        message: asString(existingInbound.message) || message
      });
    }
    logInfo(
      context,
      "[sms][webhook][duplicate-inbound] tenant=%s messageId=%s",
      tenantId,
      providerMessageId
    );
    return {
      processed: true,
      duplicate: true,
      tenantId,
      eventType,
      providerMessageId,
      inboundId: inboundRowKey,
      customerMatched: null,
      keywordCategory: existingKeyword.category || null,
      keyword: existingKeyword.keyword || null,
      autoReplySent: asString(existingInbound.keywordReplyStatus) === "sent" || !!autoReply,
      autoReplyId: autoReply ? autoReply.id : asString(existingInbound.keywordReplyId) || null,
      autoReplyDeliveryStatus: autoReply ? autoReply.deliveryStatus : null,
      autoReplySimulated: autoReply ? !!autoReply.simulated : null
    };
  }

  const customer = await findCustomerByPhone(customersClient, tenantId, fromNumber);
  const createdAt = asString(firstNonEmpty([data.receivedTimestamp, data.receivedOn, event.time, event.eventTime])) || new Date().toISOString();
  const keyword = inboundKeywordCategory(message);
  if (customer && customer.id) {
    await applyInboundConsentKeyword(customersClient, tenantId, customer.id, message, createdAt);
  }
  await upsertPhoneConsent(consentsClient, tenantId, fromNumber, keyword, customer, createdAt);
  const saved = await saveMessage(smsClient, tenantId, {
    id: inboundRowKey,
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
    deliveryStatusRaw: asString(eventType),
    deliveryUpdatedAt: createdAt,
    deliveredAt: "",
    failedAt: "",
    providerErrorCode: "",
    providerErrorMessage: ""
  });
  if (!keyword.category && (!customer || asString(customer.id).startsWith("sms-contact-"))) {
    await captureUnknownSmsLead(customersClient, smsClient, tenantId, { id: saved.id, fromNumber, message });
  }
  const autoReply = await sendAndRecordKeywordReply(context, senderClient, smsClient, settingsClient, tenantId, saved.id, {
    customerId: customer ? customer.id : "",
    customerName: customer ? customer.name : "",
    fromNumber,
    toNumber,
    message
  });
  logInfo(
    context,
    "[sms][webhook][inbound-processed] tenant=%s customer=%s keyword=%s autoReply=%s inboundId=%s",
    tenantId,
    customer && customer.id ? "matched" : "unmatched",
    keyword.category || "none",
    autoReply ? "sent" : "not-sent",
    saved.id
  );
  return {
    processed: true,
    tenantId,
    eventType,
    providerMessageId,
    inboundId: saved.id,
    customerMatched: !!(customer && customer.id),
    keywordCategory: keyword.category || null,
    keyword: keyword.keyword || null,
    autoReplySent: !!autoReply,
    autoReplyId: autoReply ? autoReply.id : null,
    autoReplyDeliveryStatus: autoReply ? autoReply.deliveryStatus : null,
    autoReplySimulated: autoReply ? !!autoReply.simulated : null
  };
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

  if (!webhookAuthorized(req)) {
    context.res = json(401, { error: "Unauthorized webhook request." });
    return;
  }

  const senderClient = await getSenderTableClient();
  const smsClient = await getSmsTableClient();
  const customersClient = await getCustomersTableClient();
  const settingsClient = await getSettingsTableClient();
  const consentsClient = await getSmsConsentsTableClient();

  let inboundProcessed = 0;
  let deliveryEvents = 0;
  let deliveryUpdated = 0;
  let ignored = 0;
  let errors = 0;
  const details = [];

  for (const event of events) {
    const type = eventTypeOf(event).toLowerCase();
    try {
      if (type.includes("smsreceived")) {
        const result = await processInboundEvent(context, senderClient, smsClient, customersClient, settingsClient, consentsClient, event);
        details.push(result);
        if (result && result.processed) inboundProcessed += 1;
        else ignored += 1;
        continue;
      }

      if (type.includes("smsdeliveryreportreceived") || type.includes("deliveryreport")) {
        deliveryEvents += 1;
        const updated = await processDeliveryEvent(senderClient, smsClient, event);
        deliveryUpdated += updated;
        details.push({
          processed: updated > 0,
          eventType: eventTypeOf(event),
          providerMessageId: asString(firstNonEmpty([eventDataOf(event).messageId, eventDataOf(event).id, event.id])),
          deliveryUpdated: updated
        });
        continue;
      }

      ignored += 1;
      details.push({
        processed: false,
        reason: "unsupported-event-type",
        eventType: eventTypeOf(event)
      });
    } catch (err) {
      errors += 1;
      logError(context, "[sms][webhook][error]", err);
      details.push({
        processed: false,
        reason: "error",
        eventType: eventTypeOf(event),
        error: String((err && err.message) || err)
      });
    }
  }

  context.res = json(errors ? 500 : 200, {
    ok: errors === 0,
    webhook: true,
    inboundProcessed,
    deliveryEvents,
    deliveryUpdated,
    ignored,
    errors,
    details
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
    const settingsTable = await getSettingsTableClient();
    const consentsTable = await getSmsConsentsTableClient();
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

      let all = await listAllMessages(smsTable, tenantId);
      await hydrateMessagesWithCustomerData(customersTable, tenantId, all);
      all = dedupeMessagesForDisplay(all);
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
        const customer = await findCustomerById(customersTable, tenantId, customerId);
        const customerPhoneKey = phoneLookupKey(customer && customer.phone);
        const resolvedCustomerId = asString(customer && customer.id) || customerId;
        let items = all
          .filter(item => {
            if (item.customerId === resolvedCustomerId || item.customerId === customerId) return true;
            if (!customerPhoneKey) return false;
            return phoneLookupKey(messageConversationPhone(item)) === customerPhoneKey;
          })
          .sort(sortByCreatedAsc);
        if (limit > 0) items = items.slice(Math.max(0, items.length - limit));
        context.res = json(200, { ok: true, tenantId, scope, customerId: resolvedCustomerId, items });
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

    if (op === "clearhistory" || op === "clear-history") {
      if (!isLoopbackRequest(req)) {
        context.res = json(403, { error: "SMS history reset is only available from localhost." });
        return;
      }
      if (!Array.isArray(principal.userRoles) || !principal.userRoles.includes("admin")) {
        context.res = json(403, { error: "Admin role is required to clear SMS history." });
        return;
      }

      const deleted = await clearTenantSmsHistory(smsTable, tenantId);
      context.res = json(200, { ok: true, tenantId, deleted });
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
      let customerId = requestCustomerId;
      if (!message) {
        context.res = json(400, { error: "message is required for logIncoming." });
        return;
      }
      if (!customerId) {
        context.res = json(400, { error: "customerId is required for logIncoming." });
        return;
      }

      const requestedCustomerRecord = await findCustomerById(customersTable, tenantId, customerId);
      const customerPhone = asString(body.from) || asString(requestedCustomerRecord && requestedCustomerRecord.phone);
      const phoneCustomerRecord = await findCustomerByPhone(customersTable, tenantId, customerPhone);
      const customerRecord = chooseCanonicalCustomer(requestedCustomerRecord, phoneCustomerRecord);
      if (customerRecord && customerRecord.id) {
        customerId = customerRecord.id;
      }
      const customerName = requestCustomerName || asString(customerRecord && customerRecord.name);

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
      await upsertPhoneConsent(
        consentsTable,
        tenantId,
        customerPhone,
        inboundKeywordCategory(message),
        { id: customerId, name: customerName },
        saved.createdAt
      );
      const autoReply = await sendAndRecordKeywordReply(context, senderTable, smsTable, settingsTable, tenantId, saved.id, {
        customerId,
        customerName,
        fromNumber: customerPhone,
        toNumber: status.fromNumber || "",
        message
      });

      context.res = json(200, {
        ok: true,
        tenantId,
        mode: getMode(),
        provider: "manual",
        simulated: true,
        direction: "inbound",
        id: saved.id,
        createdAt: saved.createdAt,
        deliveryStatus: saved.deliveryStatus,
        autoReplySent: !!autoReply,
        autoReplyId: autoReply ? autoReply.id : null
      });
      return;
    }

    const to = requestTo;
    const message = requestMessage;
    let customerId = requestCustomerId;
    let customerName = requestCustomerName;

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

    const requestedCustomerRecord = customerId ? await findCustomerById(customersTable, tenantId, customerId) : null;
    const phoneCustomerRecord = await findCustomerByPhone(customersTable, tenantId, to);
    const customerRecord = chooseCanonicalCustomer(requestedCustomerRecord, phoneCustomerRecord);
    if (customerRecord && customerRecord.id) {
      customerId = customerRecord.id;
      customerName = customerRecord.name || customerName;
    }
    await reconcileCustomerPhoneConsent(consentsTable, tenantId, to, customerRecord);

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
      }, {
        enableDeliveryReport: true,
        tag: `customer:${customerId || "unknown"}`.slice(0, 256)
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
