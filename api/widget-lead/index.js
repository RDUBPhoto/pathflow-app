const { scopedTenantPartition } = require("../_shared/notification-partition");
const { SmsClient } = require("@azure/communication-sms");
const { TableClient } = require("../_shared/table-client");
const { randomUUID } = require("crypto");
const { resolveTenantId, sanitizeTenantId } = require("../_shared/tenant");

const CUSTOMERS_TABLE = "customers";
const LANES_TABLE = "lanes";
const WORKITEMS_TABLE = "workitems";
const SMS_TABLE = "smsmessages";
const SMS_CONSENTS_TABLE = "smsconsents";
const NOTIFICATIONS_TABLE = "notifications";
const USERS_TABLE = "useraccess";
const SETTINGS_TABLE = "appsettings";
const BUSINESS_PROFILE_KEY = "business.profile";
const USERS_PARTITION = "v1";
const SENDER_TABLE = "smssenders";
const { VEHICLE_FIELDS, readVehicles, appendVehicle } = require("../_shared/customer-vehicles");
const SENDER_DEFAULT_ROW_KEY = "default";
const AUTO_CREATED_CREATOR = "Auto-Created Lead";
const DUPLICATE_REASON_WEIGHTS = Object.freeze({
  vin: 45,
  email: 30,
  phone: 15,
  name: 10
});
const DUPLICATE_MAX_SCORE = Object.values(DUPLICATE_REASON_WEIGHTS).reduce((sum, value) => sum + Number(value || 0), 0) || 100;

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asBool(value) {
  if (value === true || value === 1 || value === "1") return true;
  const text = asString(value).toLowerCase();
  return text === "true" || text === "yes" || text === "y" || text === "on";
}

function hasOwn(source, key) {
  return !!source && Object.prototype.hasOwnProperty.call(source, key);
}

function escapedFilterValue(value) {
  return asString(value).replace(/'/g, "''");
}

function escapeRegex(value) {
  return asString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeEmail(value) {
  return asString(value).toLowerCase();
}

function normalizePhone(value) {
  const digits = asString(value).replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

function normalizeE164(value) {
  const digits = asString(value).replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return "";
}

function phoneConsentRowKey(value) {
  const digits = normalizeE164(value).replace(/\D+/g, "") || normalizePhone(value);
  if (!digits) return "";
  return `phone-${digits}`.slice(0, 220);
}

function isSmsConsentOptedIn(entity) {
  const status = asString(entity && entity.status || entity && entity.smsConsentStatus).toLowerCase();
  if (!status) return false;
  if (asString(entity && (entity.revokedAt || entity.smsConsentRevokedAt))) return false;
  return ["opted-in", "opted_in", "confirmed", "subscribed"].includes(status);
}

function isRecentPendingConsent(entity) {
  const status = asString(entity && entity.status || entity && entity.smsConsentStatus).toLowerCase();
  if (status !== "pending-confirmation") return false;
  const sentAt = Date.parse(asString(entity && (entity.promptSentAt || entity.smsConsentPromptSentAt || entity.updatedAt)));
  if (!Number.isFinite(sentAt)) return false;
  const resendWindowMs = 24 * 60 * 60 * 1000;
  return Date.now() - sentAt < resendWindowMs;
}

function isE164(value) {
  return /^\+[1-9]\d{7,14}$/.test(asString(value));
}

function isValidVin(value) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(asString(value).toUpperCase());
}

function normalizeVin(value) {
  const cleaned = asString(value).toUpperCase().replace(/\s+/g, "");
  if (!cleaned) return "";
  return isValidVin(cleaned) ? cleaned : "";
}

function normalizeVehicleText(value) {
  const raw = asString(value);
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower === "not applicable" || lower === "n/a" || lower === "null" || lower === "undefined") return "";
  return raw;
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

async function decodeVinDetails(vin) {
  const cleanVin = normalizeVin(vin);
  if (!cleanVin) {
    return { vehicleYear: "", vehicleMake: "", vehicleModel: "", vehicleTrim: "" };
  }
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(cleanVin)}?format=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) return { vehicleYear: "", vehicleMake: "", vehicleModel: "", vehicleTrim: "" };
    const payload = await res.json();
    const row = payload && Array.isArray(payload.Results) ? payload.Results[0] : null;
    if (!row || typeof row !== "object") {
      return { vehicleYear: "", vehicleMake: "", vehicleModel: "", vehicleTrim: "" };
    }
    return {
      vehicleYear: normalizeVehicleText(row.ModelYear),
      vehicleMake: normalizeVehicleText(row.Make),
      vehicleModel: normalizeVehicleText(row.Model),
      vehicleTrim: normalizeVehicleText(row.Trim)
    };
  } catch (_) {
    return { vehicleYear: "", vehicleMake: "", vehicleModel: "", vehicleTrim: "" };
  }
}

function smsMode() {
  return asString(process.env.SMS_MODE).toLowerCase() === "azure" ? "azure" : "mock";
}

function splitName(name, email) {
  const raw = asString(name).replace(/\s+/g, " ").trim();
  if (raw) {
    const parts = raw.split(" ").filter(Boolean);
    const firstName = parts[0] || "";
    const lastName = parts.slice(1).join(" ");
    return {
      fullName: raw,
      firstName,
      lastName
    };
  }

  const local = normalizeEmail(email).split("@")[0] || "";
  const inferred = local
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!inferred) {
    return { fullName: "", firstName: "", lastName: "" };
  }
  const parts = inferred.split(" ").filter(Boolean);
  return {
    fullName: inferred,
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" ")
  };
}

function parseFormEncoded(text) {
  const out = {};
  const params = new URLSearchParams(text);
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

function parseRequestBody(req) {
  const raw = req && req.body;
  if (Buffer.isBuffer(raw)) return parseRequestBody({ body: raw.toString("utf8") });
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return {};
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
    return parseFormEncoded(text);
  }
  return {};
}

function queryParam(req, key) {
  if (req && req.query && req.query[key] != null) return asString(req.query[key]);
  const url = asString(req && req.url);
  if (!url || !url.includes("?")) return "";
  try {
    const parsed = new URL(url, "http://localhost");
    return asString(parsed.searchParams.get(key));
  } catch {
    return "";
  }
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

function configuredAllowedOrigins() {
  const raw = asString(process.env.WIDGET_ALLOWED_ORIGINS);
  if (!raw) return [];
  return raw
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
}

function isLocalDevOrigin(origin) {
  const value = asString(origin);
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const host = asString(parsed.hostname).toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

function localDevOriginsAllowed() {
  return asString(process.env.WIDGET_ALLOW_LOCAL_ORIGINS || "true").toLowerCase() !== "false";
}

function resolveCorsOrigin(req) {
  const origin = readHeader(req && req.headers, "origin");
  if (!origin) return "";
  if (localDevOriginsAllowed() && isLocalDevOrigin(origin)) return origin;

  const allowed = configuredAllowedOrigins();
  if (!allowed.length) return "*";
  if (allowed.includes("*")) return "*";
  if (allowed.includes(origin)) return origin;
  return "";
}

function corsHeaders(req) {
  const origin = resolveCorsOrigin(req);
  const headers = {
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-widget-key,x-tenant-id",
    "access-control-max-age": "86400"
  };
  if (origin) headers["access-control-allow-origin"] = origin;
  if (origin && origin !== "*") headers.vary = "Origin";
  return headers;
}

function json(req, status, body) {
  return {
    status,
    headers: {
      "content-type": "application/json",
      ...corsHeaders(req)
    },
    body
  };
}

function sameOriginRequest(req) {
  const origin = readHeader(req && req.headers, "origin");
  const host = readHeader(req && req.headers, "x-forwarded-host") || readHeader(req && req.headers, "host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function isWidgetAuthorized(req, body) {
  const expected = asString(process.env.WIDGET_API_KEY);
  if (!expected) return true;

  const provided = asString(
    readHeader(req && req.headers, "x-widget-key")
      || queryParam(req, "key")
      || body.apiKey
      || body.widgetKey
      || body.key
      || body.token
  );

  if (provided && provided === expected) return true;

  const allowSameOrigin = asString(process.env.WIDGET_ALLOW_SAME_ORIGIN_FORM || "true").toLowerCase() !== "false";
  return allowSameOrigin && sameOriginRequest(req);
}

function isOriginAllowed(req) {
  const origin = readHeader(req && req.headers, "origin");
  if (!origin) return true;
  if (localDevOriginsAllowed() && isLocalDevOrigin(origin)) return true;

  const allowed = configuredAllowedOrigins();
  if (!allowed.length) return true;
  if (allowed.includes("*")) return true;
  return allowed.includes(origin);
}

async function getTableClient(table) {
  const conn = asString(process.env.STORAGE_CONNECTION_STRING);
  if (!conn) throw new Error("Missing STORAGE_CONNECTION_STRING");
  const client = TableClient.fromConnectionString(conn, table);
  try {
    await client.createTable();
  } catch (_) {}
  return client;
}

async function ensureLeadsLane(lanesClient, tenantId) {
  const safeTenant = escapedFilterValue(tenantId);
  const iter = lanesClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${safeTenant}'` } });
  let maxSort = 0;
  let existing = null;
  for await (const entity of iter) {
    const name = asString(entity.name);
    const sort = Number(entity.sort);
    if (Number.isFinite(sort)) maxSort = Math.max(maxSort, sort);
    if (!existing && /\bleads?\b/i.test(name)) {
      existing = { id: asString(entity.rowKey), name: name || "Leads" };
    }
  }

  if (existing && existing.id) return existing;

  const id = randomUUID();
  await lanesClient.upsertEntity(
    {
      partitionKey: tenantId,
      rowKey: id,
      name: "Leads",
      sort: maxSort + 10
    },
    "Merge"
  );
  return { id, name: "Leads" };
}

function customerFromEntity(entity) {
  return {
    ...Object.fromEntries(VEHICLE_FIELDS.map(key => [key, asString(entity[key])])),
    vehiclesJson: entity.vehiclesJson,
    primaryVehicleId: entity.primaryVehicleId,
    id: asString(entity.rowKey),
    name: asString(entity.name),
    firstName: asString(entity.firstName),
    lastName: asString(entity.lastName),
    email: asString(entity.email),
    phone: asString(entity.phone),
    vin: asString(entity.vin),
    creator: asString(entity.creator),
    notes: asString(entity.notes),
    createdAt: asString(entity.createdAt),
    updatedAt: asString(entity.updatedAt),
    smsConsentStatus: asString(entity.smsConsentStatus)
  };
}

async function findMatchingCustomer(customersClient, inbound, tenantId) {
  const targetEmail = normalizeEmail(inbound.email);
  const targetPhone = normalizePhone(inbound.phone);
  const targetName = asString(inbound.name).toLowerCase();
  const targetVin = normalizeVin(inbound.vin);
  if (!targetEmail && !targetPhone && !targetName && !targetVin) return null;

  let best = null;
  const safeTenant = escapedFilterValue(tenantId);
  const iter = customersClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${safeTenant}'` } });
  for await (const entity of iter) {
    const current = customerFromEntity(entity);
    let score = 0;
    const reasons = [];

    if (targetVin && readVehicles(current).some(vehicle => normalizeVin(vehicle.vin) === targetVin)) {
      score += DUPLICATE_REASON_WEIGHTS.vin;
      reasons.push("vin");
    }
    if (targetEmail && normalizeEmail(current.email) === targetEmail) {
      score += DUPLICATE_REASON_WEIGHTS.email;
      reasons.push("email");
    }
    if (targetPhone && normalizePhone(current.phone) === targetPhone) {
      score += DUPLICATE_REASON_WEIGHTS.phone;
      reasons.push("phone");
    }
    if (targetName) {
      const currentName = asString(current.name || `${current.firstName} ${current.lastName}`.trim()).toLowerCase();
      if (currentName && currentName === targetName) {
        score += DUPLICATE_REASON_WEIGHTS.name;
        reasons.push("name");
      }
    }
    if (!score) continue;
    const confidence = Math.max(0, Math.min(100, Math.round((score / DUPLICATE_MAX_SCORE) * 100)));
    if (!best || score > best.score) best = { customer: current, score, confidence, reasons };
  }

  return best;
}

function duplicateMatchThresholds() {
  const auto = Number(process.env.WIDGET_DUPLICATE_AUTO_MERGE_PERCENT);
  const review = Number(process.env.WIDGET_DUPLICATE_REVIEW_PERCENT);
  const autoMerge = Number.isFinite(auto) ? Math.max(0, Math.min(100, Math.round(auto))) : 80;
  const reviewNeeded = Number.isFinite(review) ? Math.max(0, Math.min(autoMerge, Math.round(review))) : 55;
  return { autoMerge, reviewNeeded };
}

function duplicateMatchAction(confidence) {
  const safeConfidence = Number.isFinite(Number(confidence)) ? Number(confidence) : 0;
  const thresholds = duplicateMatchThresholds();
  if (safeConfidence >= thresholds.autoMerge) return "auto-merge";
  if (safeConfidence >= thresholds.reviewNeeded) return "review";
  return "no-match";
}

function shouldForceReuseExistingCustomer(match) {
  if (!match || !match.customer) return false;
  const reasons = new Set(
    (Array.isArray(match.reasons) ? match.reasons : [])
      .map(value => asString(value).toLowerCase())
      .filter(Boolean)
  );
  const hasName = reasons.has("name");
  const hasVin = reasons.has("vin");
  const hasEmail = reasons.has("email");
  const hasPhone = reasons.has("phone");
  if (hasName && hasVin) return true;
  if (hasName && hasEmail && hasPhone) return true;
  return false;
}

function duplicateReviewFields(match) {
  if (!match || !match.customer) return null;
  return {
    duplicateReviewStatus: "pending",
    duplicateReviewCandidateId: asString(match.customer.id),
    duplicateReviewCandidateName: asString(match.customer.name),
    duplicateReviewConfidence: Number(match.confidence) || 0,
    duplicateReviewScore: Number(match.score) || 0,
    duplicateReviewReasons: Array.isArray(match.reasons) ? match.reasons.join(",") : "",
    duplicateReviewUpdatedAt: new Date().toISOString()
  };
}


function rowKeyForLeadNotification(leadId, recipientKey) {
  return String(`lead-${leadId}-submitted-${asString(recipientKey)}`)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 220);
}

function mergeNotes(existingNotes, message, sourceName) {
  const existing = asString(existingNotes);
  const inbound = asString(message);
  if (!inbound) return existing;
  const sourceLabel = `Web Lead${sourceName ? ` - ${sourceName}` : ""}`;
  const dedupePattern = new RegExp(`\\[${escapeRegex(sourceLabel)}\\s*•[^\\]]*\\]\\n${escapeRegex(inbound)}(?:\\n|$)`, "m");
  if (existing && dedupePattern.test(existing)) return existing;
  const stamp = new Date().toLocaleString("en-US", { hour12: true });
  const block = `[${sourceLabel} • ${stamp}]\n${inbound}`;
  if (!existing) return block;
  return `${existing}\n\n${block}`;
}

function initialConsentStatus(inbound) {
  if (!asString(inbound.phone)) return "not-applicable";
  if (!inbound.smsOptInProvided) return "unknown";
  return inbound.smsOptIn ? "consent-captured" : "not-consented";
}

function applyConsentFields(entity, inbound, now, status) {
  if (!inbound.smsOptInProvided) return;

  entity.smsConsentStatus = status;
  entity.smsConsentUpdatedAt = now;
  entity.smsConsentMethod = asString(inbound.consentMethod || "web-checkbox");
  entity.smsConsentSource = asString(inbound.sourceName);
  entity.smsConsentVersion = asString(inbound.consentVersion || "v1");
  entity.smsConsentText = asString(inbound.consentText);
  entity.smsConsentPageUrl = asString(inbound.optInPageUrl);
  entity.smsConsentIp = asString(inbound.ipAddress);
  if (inbound.smsOptIn) entity.smsConsentProvidedAt = now;
}

async function createCustomer(customersClient, inbound, tenantId) {
  const now = new Date().toISOString();
  const id = randomUUID();
  const names = splitName(inbound.name, inbound.email);
  const fullName = asString(inbound.name) || names.fullName || asString(inbound.email) || "Website Lead";
  const entity = {
    partitionKey: tenantId,
    rowKey: id,
    name: fullName,
    firstName: names.firstName,
    lastName: names.lastName,
    email: asString(inbound.email),
    phone: asString(inbound.phoneE164 || inbound.phone),
    vin: asString(inbound.vin),
    vehicleYear: asString(inbound.vehicleYear),
    vehicleMake: asString(inbound.vehicleMake),
    vehicleModel: asString(inbound.vehicleModel),
    vehicleTrim: asString(inbound.vehicleTrim),
    creator: AUTO_CREATED_CREATOR,
    notes: mergeNotes("", inbound.message, inbound.sourceName),
    leadSource: "web",
    createdAt: now,
    updatedAt: now
  };
  applyConsentFields(entity, inbound, now, initialConsentStatus(inbound));
  const added = appendVehicle({}, inbound);
  Object.assign(entity, added.patch);
  inbound.vehicleId = added.vehicle?.id || "";

  await customersClient.upsertEntity(entity, "Merge");

  return {
    ...entity,
    id,
    name: fullName,
    firstName: names.firstName,
    lastName: names.lastName,
    email: asString(inbound.email),
    phone: asString(inbound.phoneE164 || inbound.phone),
    vin: asString(inbound.vin),
    vehicleYear: asString(inbound.vehicleYear),
    vehicleMake: asString(inbound.vehicleMake),
    vehicleModel: asString(inbound.vehicleModel),
    vehicleTrim: asString(inbound.vehicleTrim)
  };
}

async function updateCustomerFromInbound(customersClient, customer, inbound, tenantId) {
  const now = new Date().toISOString();
  const patch = {
    partitionKey: tenantId,
    rowKey: customer.id,
    updatedAt: now,
    leadSource: "web"
  };

  const names = splitName(inbound.name, inbound.email);
  const fullName = asString(inbound.name) || names.fullName;
  if (!asString(customer.name) && fullName) patch.name = fullName;
  if (!asString(customer.firstName) && names.firstName) patch.firstName = names.firstName;
  if (!asString(customer.lastName) && names.lastName) patch.lastName = names.lastName;
  if (!asString(customer.email) && asString(inbound.email)) patch.email = asString(inbound.email);
  if (!asString(customer.phone) && asString(inbound.phoneE164 || inbound.phone)) {
    patch.phone = asString(inbound.phoneE164 || inbound.phone);
  }
  const added = appendVehicle(customer, inbound);
  Object.assign(patch, added.patch);
  inbound.vehicleId = added.vehicle?.id || "";
  if (!asString(customer.creator)) patch.creator = AUTO_CREATED_CREATOR;

  const nextNotes = mergeNotes(customer.notes, inbound.message, inbound.sourceName);
  if (nextNotes !== asString(customer.notes)) patch.notes = nextNotes;

  if (inbound.smsOptInProvided) {
    const existingStatus = asString(customer.smsConsentStatus).toLowerCase();
    const consentLocked = existingStatus === "opted-in" || existingStatus === "pending-confirmation";
    if (!consentLocked || inbound.smsOptIn) {
      applyConsentFields(patch, inbound, now, initialConsentStatus(inbound));
    }
  }

  await customersClient.upsertEntity(patch, "Merge");
  return { ...customer, ...patch };
}

async function setCustomerConsentStatus(customersClient, tenantId, customerId, status, extra = {}) {
  if (!customerId || !status) return;
  const now = new Date().toISOString();
  await customersClient.upsertEntity(
    {
      partitionKey: tenantId,
      rowKey: customerId,
      smsConsentStatus: status,
      smsConsentUpdatedAt: now,
      updatedAt: now,
      ...extra
    },
    "Merge"
  );
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

async function upsertPhoneConsent(consentsClient, tenantId, phone, status, extra = {}) {
  const rowKey = phoneConsentRowKey(phone);
  const phoneE164 = normalizeE164(phone);
  if (!rowKey || !status) return;
  const now = new Date().toISOString();
  await consentsClient.upsertEntity(
    {
      partitionKey: tenantId,
      rowKey,
      phoneE164,
      phoneKey: rowKey.replace(/^phone-/, ""),
      status,
      updatedAt: now,
      ...extra
    },
    "Merge"
  );
}

async function applyKnownPhoneConsent(customersClient, tenantId, customer, phoneConsent) {
  if (!customer || !customer.id || !isSmsConsentOptedIn(phoneConsent)) return;
  await setCustomerConsentStatus(customersClient, tenantId, customer.id, "opted-in", {
    smsConsentConfirmedAt: asString(phoneConsent.confirmedAt || phoneConsent.smsConsentConfirmedAt),
    smsConsentKeyword: asString(phoneConsent.keyword || phoneConsent.smsConsentKeyword),
    smsConsentMethod: asString(phoneConsent.method || "sms-keyword"),
    smsConsentSource: asString(phoneConsent.source || "smsconsents"),
    smsConsentPromptError: ""
  });
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
  const allLocations = asBool(userEntity && userEntity.allLocations);
  if (allLocations) return true;
  const locations = parseUserLocationIds(userEntity);
  if (!locations.length) return true;
  return locations.includes(asString(tenantId).toLowerCase());
}

async function listTenantNotificationRecipients(usersClient, tenantId) {
  const filter = `PartitionKey eq '${escapedFilterValue(USERS_PARTITION)}'`;
  const seen = new Set();
  const out = [];
  const iter = usersClient.listEntities({ queryOptions: { filter } });
  for await (const entity of iter) {
    if (!userCanAccessTenant(entity, tenantId)) continue;
    const status = asString(entity.status).toLowerCase();
    if (status === "disabled") continue;
    const email = normalizeEmail(entity.email || entity.rowKey);
    const userId = asString(entity.userId || email);
    if (!email && !userId) continue;
    const keys = [
      email ? `email:${email}` : "",
      userId ? `user:${userId}` : ""
    ].filter(Boolean);
    if (keys.some(key => seen.has(key))) continue;
    keys.forEach(key => seen.add(key));
    out.push({
      targetUserId: userId || "",
      targetEmail: email || "",
      targetDisplayName: asString(entity.displayName || email || userId || "User")
    });
  }
  return out;
}

async function createLeadNotifications(notificationClient, usersClient, tenantId, leadId, customer) {
  const recipients = await listTenantNotificationRecipients(usersClient, tenantId);
  if (!recipients.length) return 0;
  const scopedTenant = scopedTenantPartition(tenantId);
  const leadName = asString(customer && customer.name) || "Customer";
  const customerId = asString(customer && customer.id);
  const route = customerId ? `/customers/${encodeURIComponent(customerId)}` : "/dashboard";
  const nowIso = new Date().toISOString();
  let created = 0;
  for (const recipient of recipients) {
    const recipientKey = asString(recipient.targetEmail || recipient.targetUserId);
    if (!recipientKey) continue;
    const id = rowKeyForLeadNotification(leadId, recipientKey);
    try {
      await notificationClient.upsertEntity(
        {
          partitionKey: scopedTenant,
          rowKey: id,
          tenantId,
          type: "mention",
          title: `${leadName} submitted a new lead`,
          message: `${leadName} submitted a new lead.`,
          route,
          entityType: "lead",
          entityId: customerId || leadId,
          metadataJson: JSON.stringify({
            source: "widget-lead",
            leadItemId: asString(leadId),
            customerId,
            customerName: leadName,
            customerEmail: normalizeEmail(customer && customer.email),
            customerPhone: normalizePhone(customer && customer.phone)
          }),
          targetUserId: asString(recipient.targetUserId),
          targetEmail: normalizeEmail(recipient.targetEmail),
          targetDisplayName: asString(recipient.targetDisplayName),
          actorUserId: "system",
          actorEmail: "",
          actorDisplayName: "System",
          read: false,
          readAt: "",
          createdAt: nowIso,
          updatedAt: nowIso
        },
        "Merge"
      );
      created += 1;
    } catch (_) {}
  }
  return created;
}

async function findExistingLeadForCustomer(workItemsClient, laneId, customerId, tenantId, inbound) {
  const safeTenant = escapedFilterValue(tenantId);
  const safeLane = escapedFilterValue(laneId);
  const safeCustomer = escapedFilterValue(customerId);
  const filter = `PartitionKey eq '${safeTenant}' and laneId eq '${safeLane}' and customerId eq '${safeCustomer}'`;
  const iter = workItemsClient.listEntities({ queryOptions: { filter } });

  let latest = null;
  for await (const entity of iter) {
    if (inbound.vehicleId && entity.vehicleId && inbound.vehicleId !== entity.vehicleId) continue;
    if (!inbound.vin && (inbound.vehicleMake || inbound.vehicleModel) &&
      ["vehicleYear", "vehicleMake", "vehicleModel"].some(key => asString(entity[key]).toLowerCase() !== asString(inbound[key]).toLowerCase())) continue;
    if (asString(entity.source) !== "web" || asString(entity.message) !== asString(inbound.message) ||
        asString(entity.vin) !== asString(inbound.vin)) continue;
    const createdAt = asString(entity.createdAt);
    const updatedAt = asString(entity.updatedAt);
    const ts = Date.parse(updatedAt || createdAt || "");
    if (!Number.isFinite(ts) || Date.now() - ts > 10 * 60 * 1000) continue;
    if (!latest || ts > latest.ts) {
      latest = { id: asString(entity.rowKey), ts: Number.isFinite(ts) ? ts : 0 };
    }
  }
  return latest;
}

async function nextLaneSort(workItemsClient, laneId, tenantId) {
  const safeTenant = escapedFilterValue(tenantId);
  const safeLane = escapedFilterValue(laneId);
  const iter = workItemsClient.listEntities({
    queryOptions: { filter: `PartitionKey eq '${safeTenant}' and laneId eq '${safeLane}'` }
  });
  let maxSort = 0;
  for await (const entity of iter) {
    const sort = Number(entity.sort);
    if (Number.isFinite(sort)) maxSort = Math.max(maxSort, sort);
  }
  return maxSort + 10;
}

function intakeSourceName(body) {
  return asString(body.source || body.site || body.website || body.origin || "website-widget");
}

function buildLeadTitle(customer, inbound) {
  const base = asString(customer && customer.name) || asString(customer && customer.email) || asString(customer && customer.phone) || "New Lead";
  const vehicle = [asString(inbound && inbound.vehicleYear), asString(inbound && inbound.vehicleMake), asString(inbound && inbound.vehicleModel)]
    .filter(Boolean)
    .join(" ");
  const suffix = vehicle || (asString(inbound && inbound.vin) ? `VIN ${asString(inbound && inbound.vin)}` : "Web Lead");
  return `${base} — ${suffix}`.slice(0, 240);
}

async function createLead(workItemsClient, laneId, inbound, customer, tenantId) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const sort = await nextLaneSort(workItemsClient, laneId, tenantId);
  const sourceName = intakeSourceName(inbound.raw);
  await workItemsClient.upsertEntity(
    {
      partitionKey: tenantId,
      rowKey: id,
      laneId,
      title: buildLeadTitle(customer, inbound),
      customerId: customer.id,
      vehicleId: asString(inbound.vehicleId),
      customerName: customer.name,
      sort,
      source: "web",
      leadSource: "web",
      intakeSource: sourceName,
      origin: sourceName,
      channel: "website",
      contactEmail: customer.email || "",
      contactPhone: customer.phone || "",
      vin: asString(inbound.vin),
      vehicleYear: asString(inbound.vehicleYear),
      vehicleMake: asString(inbound.vehicleMake),
      vehicleModel: asString(inbound.vehicleModel),
      vehicleTrim: asString(inbound.vehicleTrim),
      message: asString(inbound.message),
      duplicateReviewStatus: asString(customer.duplicateReviewStatus),
      duplicateReviewCandidateId: asString(customer.duplicateReviewCandidateId),
      duplicateReviewCandidateName: asString(customer.duplicateReviewCandidateName),
      duplicateReviewConfidence: Number(customer.duplicateReviewConfidence) || 0,
      duplicateReviewScore: Number(customer.duplicateReviewScore) || 0,
      duplicateReviewReasons: asString(customer.duplicateReviewReasons),
      duplicateReviewUpdatedAt: asString(customer.duplicateReviewUpdatedAt),
      createdAt: now,
      updatedAt: now
    },
    "Merge"
  );
  return id;
}

async function touchLead(workItemsClient, id, inbound, tenantId, laneId, customer) {
  const sourceName = intakeSourceName(inbound.raw);
  const nextSort = laneId ? await nextLaneSort(workItemsClient, laneId, tenantId) : null;
  await workItemsClient.upsertEntity(
    {
      partitionKey: tenantId,
      rowKey: id,
      updatedAt: new Date().toISOString(),
      title: buildLeadTitle(customer, inbound),
      customerId: asString(customer && customer.id),
      vehicleId: asString(inbound.vehicleId),
      customerName: asString(customer && customer.name),
      source: "web",
      leadSource: "web",
      intakeSource: sourceName,
      origin: sourceName,
      channel: "website",
      contactEmail: asString(customer && customer.email),
      contactPhone: asString(customer && customer.phone),
      vin: asString(inbound.vin),
      vehicleYear: asString(inbound.vehicleYear),
      vehicleMake: asString(inbound.vehicleMake),
      vehicleModel: asString(inbound.vehicleModel),
      vehicleTrim: asString(inbound.vehicleTrim),
      message: asString(inbound.message),
      duplicateReviewStatus: asString(customer && customer.duplicateReviewStatus),
      duplicateReviewCandidateId: asString(customer && customer.duplicateReviewCandidateId),
      duplicateReviewCandidateName: asString(customer && customer.duplicateReviewCandidateName),
      duplicateReviewConfidence: Number(customer && customer.duplicateReviewConfidence) || 0,
      duplicateReviewScore: Number(customer && customer.duplicateReviewScore) || 0,
      duplicateReviewReasons: asString(customer && customer.duplicateReviewReasons),
      duplicateReviewUpdatedAt: asString(customer && customer.duplicateReviewUpdatedAt),
      ...(Number.isFinite(Number(nextSort)) ? { sort: Number(nextSort) } : {})
    },
    "Merge"
  );
}

function deliveryStatusFromRaw(raw) {
  const value = asString(raw).toLowerCase();
  if (!value) return "queued";
  if (value.includes("deliver")) return "delivered";
  if (value.includes("fail") || value.includes("reject") || value.includes("undeliver") || value.includes("expire")) return "failed";
  return "queued";
}

async function resolveSenderNumber(senderClient, tenantId) {
  try {
    const configured = await senderClient.getEntity(tenantId, SENDER_DEFAULT_ROW_KEY);
    const sender = normalizeE164(configured.fromNumber);
    if (sender) return sender;
  } catch (_) {}
  return normalizeE164(process.env.ACS_SMS_FROM);
}

function optInKeyword() {
  return asString(process.env.WIDGET_SMS_CONFIRM_KEYWORD || "START").toUpperCase();
}

function customerSafeBrandFallback(value) {
  const brand = asString(value);
  return brand && brand.toLowerCase() !== "pathflow" ? brand : "";
}

function defaultOptInMessage() {
  const keyword = optInKeyword();
  const brand = customerSafeBrandFallback(process.env.WIDGET_BRAND_NAME) || "Your service team";
  return `${brand}: Reply ${keyword} or YES to confirm SMS updates for your service request. Msg freq varies. Msg&data rates may apply. Reply STOP to opt out, HELP for help.`;
}

function parseSettingValue(value) {
  const raw = asString(value);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function resolveWidgetBrandName(settingsClient, tenantId) {
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
      const profile = parseSettingValue(entity && entity.valueJson);
      const companyName = customerSafeBrandFallback(profile && profile.companyName);
      if (companyName) return companyName;
    } catch (_) {}
  }
  return customerSafeBrandFallback(process.env.WIDGET_BRAND_NAME) || "Your service team";
}

async function buildOptInMessage(settingsClient, tenantId) {
  const brand = await resolveWidgetBrandName(settingsClient, tenantId);
  const raw = asString(process.env.WIDGET_SMS_OPT_IN_MESSAGE);
  if (!raw) {
    const keyword = optInKeyword();
    return `${brand}: Reply ${keyword} or YES to confirm SMS updates for your service request. Msg freq varies. Msg&data rates may apply. Reply STOP to opt out, HELP for help.`;
  }
  return raw
    .replace(/\{keyword\}/gi, optInKeyword())
    .replace(/\{brand\}/gi, brand);
}

function shouldSendOptInConfirmation(inbound, phoneConsent) {
  if (!inbound.smsOptIn) return false;
  if (!inbound.phoneE164) return false;
  if (isSmsConsentOptedIn(phoneConsent)) return false;
  if (isRecentPendingConsent(phoneConsent)) return false;
  return asString(process.env.WIDGET_SEND_OPT_IN_CONFIRMATION || "true").toLowerCase() !== "false";
}

async function sendOptInConfirmation(to, from, message, context) {
  const mode = smsMode();
  if (!to || !isE164(to)) {
    return { attempted: false, sent: false, simulated: false, status: "invalid-phone", messageId: "", error: "Phone must be E.164." };
  }

  if (mode !== "azure") {
    return { attempted: true, sent: true, simulated: true, status: "delivered", rawStatus: "mock", messageId: "" };
  }

  const conn = asString(process.env.ACS_CONNECTION_STRING);
  if (!conn || !from) {
    return {
      attempted: true,
      sent: false,
      simulated: false,
      status: "not-configured",
      messageId: "",
      error: "ACS connection string or sender number is missing."
    };
  }

  const client = new SmsClient(conn);
  let response;
  try {
    response = await client.send({ from, to: [to], message });
  } catch (err) {
    if (context && context.log && typeof context.log.warn === "function") {
      context.log.warn("[widget-lead][sms-opt-in] provider rejected", {
        to,
        message: asString(err && err.message)
      });
    }
    return {
      attempted: true,
      sent: false,
      simulated: false,
      status: "failed",
      rawStatus: "ProviderValidationFailed",
      messageId: "",
      error: asString(err && err.message) || "Provider rejected message."
    };
  }
  const first = Array.isArray(response)
    ? response[0]
    : (Array.isArray(response && response.results) ? response.results[0] : response);
  const successful = first && typeof first.successful === "boolean" ? first.successful : true;
  const rawStatus = asString(first && (first.deliveryStatus || first.status || "Queued")) || "Queued";
  if (!successful) {
    return {
      attempted: true,
      sent: false,
      simulated: false,
      status: "failed",
      rawStatus,
      messageId: asString(first && first.messageId),
      error: asString(first && (first.errorMessage || first.code || "Provider rejected message."))
    };
  }

  return {
    attempted: true,
    sent: true,
    simulated: false,
    status: deliveryStatusFromRaw(rawStatus),
    rawStatus,
    messageId: asString(first && first.messageId),
    error: ""
  };
}

async function saveSmsOutboundConfirmation(smsClient, tenantId, customer, to, from, message, sendResult) {
  const now = new Date().toISOString();
  await smsClient.upsertEntity(
    {
      partitionKey: tenantId,
      rowKey: randomUUID(),
      customerId: asString(customer && customer.id),
      customerName: asString(customer && customer.name),
      direction: "outbound",
      fromNumber: asString(from),
      toNumber: asString(to),
      message: asString(message),
      createdAt: now,
      read: true,
      readAt: now,
      simulated: !!sendResult.simulated,
      provider: sendResult.simulated ? "mock" : "azure-communication-services",
      providerMessageId: asString(sendResult.messageId),
      deliveryStatus: asString(sendResult.status || "queued"),
      deliveryStatusRaw: asString(sendResult.rawStatus || (sendResult.simulated ? "mock" : "")),
      deliveryUpdatedAt: now,
      deliveredAt: asString(sendResult.status) === "delivered" ? now : "",
      failedAt: asString(sendResult.status) === "failed" ? now : "",
      providerErrorCode: "",
      providerErrorMessage: asString(sendResult.error),
      updatedAt: now
    },
    "Merge"
  );
}

function inboundFromBody(req, body) {
  const email = normalizeEmail(body.email || body.emailAddress || body.contactEmail);
  const phone = asString(body.phone || body.phoneNumber || body.mobile || body.contactPhone);
  const vin = asString(body.vin || body.vehicleVin || body.vehicleVIN)
    .toUpperCase()
    .replace(/\s+/g, "");
  const name = asString(body.name || body.fullName || body.customerName);
  const firstName = asString(body.firstName || body.givenName);
  const lastName = asString(body.lastName || body.familyName);
  const composedName = name || `${firstName} ${lastName}`.trim();
  const message = asString(body.message || body.notes || body.details || body.comment);
  const sourceName = intakeSourceName(body);
  const smsOptInProvided = hasOwn(body, "smsOptIn")
    || hasOwn(body, "optInSms")
    || hasOwn(body, "smsConsent")
    || hasOwn(body, "acceptSms")
    || hasOwn(body, "sms_opt_in");
  const smsOptIn = smsOptInProvided
    ? asBool(body.smsOptIn ?? body.optInSms ?? body.smsConsent ?? body.acceptSms ?? body.sms_opt_in)
    : false;
  const ipAddress = asString(readHeader(req && req.headers, "x-forwarded-for")).split(",")[0].trim();

  return {
    name: composedName,
    firstName,
    lastName,
    email,
    phone: normalizeE164(phone) || phone,
    phoneE164: normalizeE164(phone),
    vin,
    vehicleYear: asString(body.vehicleYear || body.year),
    vehicleMake: asString(body.vehicleMake || body.make),
    vehicleModel: asString(body.vehicleModel || body.model),
    vehicleTrim: asString(body.vehicleTrim || body.trim),
    message,
    sourceName,
    smsOptInProvided,
    smsOptIn,
    consentMethod: asString(body.consentMethod || "web-checkbox"),
    consentVersion: asString(body.smsConsentVersion || body.consentVersion || "v1"),
    consentText: asString(body.smsConsentText || body.consentText),
    optInPageUrl: asString(body.optInPageUrl || body.pageUrl || body.sourceUrl || body.url),
    ipAddress,
    raw: body
  };
}

module.exports = async function (context, req) {
  const method = asString(req.method || "GET").toUpperCase();
  const body = parseRequestBody(req);
  const requestedTenantId = resolveTenantId(req, body);
  const tenantId = requestedTenantId;

  if (method === "OPTIONS") {
    context.res = { status: 204, headers: corsHeaders(req) };
    return;
  }

  if (!isOriginAllowed(req)) {
    context.res = json(req, 403, { error: "Origin is not allowed for widget intake." });
    return;
  }

  if (method === "GET") {
    context.res = json(req, 200, {
      ok: true,
      route: "widget/lead",
      tenantId,
      requestedTenantId,
      securedByApiKey: !!asString(process.env.WIDGET_API_KEY),
      accepts: ["name", "phone", "email", "vin", "message", "smsOptIn"],
      requiredFields: ["email or phone", "name (recommended)", "message", "smsOptIn (if phone will receive SMS)", "vin (optional, 17 chars, A-HJ-NPR-Z0-9 if provided)"]
    });
    return;
  }

  if (method !== "POST") {
    context.res = json(req, 405, { error: "Method not allowed" });
    return;
  }

  if (!isWidgetAuthorized(req, body)) {
    context.res = json(req, 401, { error: "Unauthorized widget request." });
    return;
  }

  const inbound = inboundFromBody(req, body);
  if (!inbound.email && !inbound.phone) {
    context.res = json(req, 400, { error: "At least one contact field is required (`email` or `phone`)." });
    return;
  }
  if (!inbound.message) {
    context.res = json(req, 400, { error: "Message is required." });
    return;
  }
  if (inbound.vin && !isValidVin(inbound.vin)) {
    context.res = json(req, 400, { error: "VIN must be 17 characters and cannot include I, O, or Q." });
    return;
  }
  if (inbound.smsOptIn && !inbound.phoneE164) {
    context.res = json(req, 400, { error: "Phone must be valid when SMS opt-in is checked (E.164 or US 10-digit)." });
    return;
  }

  if (inbound.vin) {
    const vinDetails = await decodeVinDetails(inbound.vin);
    inbound.vehicleYear = vinDetails.vehicleYear || inbound.vehicleYear;
    inbound.vehicleMake = vinDetails.vehicleMake || inbound.vehicleMake;
    inbound.vehicleModel = vinDetails.vehicleModel || inbound.vehicleModel;
    inbound.vehicleTrim = vinDetails.vehicleTrim || inbound.vehicleTrim;
  }

  try {
    const customersClient = await getTableClient(CUSTOMERS_TABLE);
    const lanesClient = await getTableClient(LANES_TABLE);
    const workItemsClient = await getTableClient(WORKITEMS_TABLE);
    const notificationsClient = await getTableClient(NOTIFICATIONS_TABLE);
    const usersClient = await getTableClient(USERS_TABLE);
    const smsConsentsClient = await getTableClient(SMS_CONSENTS_TABLE);
    const phoneConsent = inbound.phoneE164
      ? await getPhoneConsent(smsConsentsClient, tenantId, inbound.phoneE164)
      : null;

    const match = await findMatchingCustomer(customersClient, inbound, tenantId);
    const matchAction = duplicateMatchAction(match && Number(match.confidence));
    const forceReuse = shouldForceReuseExistingCustomer(match);
    let customer = null;
    let customerCreated = false;
    let matchedBy = [];

    if (match && match.customer && forceReuse) {
      customer = match.customer;
      matchedBy = match.reasons;
      customer = await updateCustomerFromInbound(customersClient, match.customer, inbound, tenantId);
    } else {
      customer = await createCustomer(customersClient, inbound, tenantId);
      customerCreated = true;
      if (match && match.customer) {
        const now = new Date().toISOString();
        const review = duplicateReviewFields(match);
        Object.assign(customer, review);
        await customersClient.upsertEntity(
          {
            partitionKey: tenantId,
            rowKey: customer.id,
            ...review,
            duplicateReviewUpdatedAt: now,
            updatedAt: now
          },
          "Merge"
        );
      }
    }

    try {
      await applyKnownPhoneConsent(customersClient, tenantId, customer, phoneConsent);
    } catch (consentError) {
      context.log.warn("[widget-lead][consent] could not apply known consent", {
        tenantId,
        customerId: asString(customer && customer.id),
        error: asString(consentError && consentError.message || consentError)
      });
    }

    const leadsLane = await ensureLeadsLane(lanesClient, tenantId);
    const allowDuplicates = asString(process.env.WIDGET_CREATE_DUPLICATE_LEADS).toLowerCase() === "true";
    let leadId = "";
    let leadCreated = false;

    if (!allowDuplicates && customer && customer.id) {
      const existing = await findExistingLeadForCustomer(workItemsClient, leadsLane.id, customer.id, tenantId, inbound);
      if (existing && existing.id) {
        leadId = existing.id;
        await touchLead(workItemsClient, leadId, inbound, tenantId, leadsLane.id, customer);
      }
    }

    if (!leadId) {
      leadId = await createLead(workItemsClient, leadsLane.id, inbound, customer, tenantId);
      leadCreated = true;
      try {
        await createLeadNotifications(notificationsClient, usersClient, tenantId, leadId, customer);
      } catch (notificationError) {
        context.log.warn("[widget-lead][notification] lead captured but notification failed", {
          tenantId,
          leadId,
          error: asString(notificationError && notificationError.message || notificationError)
        });
      }
    }

    let consentStatus = isSmsConsentOptedIn(phoneConsent) ? "opted-in" : initialConsentStatus(inbound);
    let confirmation = {
      attempted: false,
      sent: false,
      simulated: false,
      status: isSmsConsentOptedIn(phoneConsent) ? "already-opted-in" : "not-requested",
      messageId: "",
      error: ""
    };

    if (shouldSendOptInConfirmation(inbound, phoneConsent)) {
      try {
        const senderClient = await getTableClient(SENDER_TABLE);
        const smsClient = await getTableClient(SMS_TABLE);
        const settingsClient = await getTableClient(SETTINGS_TABLE);
        const sender = await resolveSenderNumber(senderClient, tenantId);
        const message = await buildOptInMessage(settingsClient, tenantId);
        confirmation = await sendOptInConfirmation(inbound.phoneE164, sender, message, context);
        if (confirmation.sent) {
          await saveSmsOutboundConfirmation(smsClient, tenantId, customer, inbound.phoneE164, sender, message, confirmation);
          consentStatus = "pending-confirmation";
          await upsertPhoneConsent(smsConsentsClient, tenantId, inbound.phoneE164, "pending-confirmation", {
            customerId: customer && customer.id ? customer.id : "",
            promptSentAt: new Date().toISOString(),
            promptMessageId: asString(confirmation.messageId),
            expectedKeyword: optInKeyword(),
            source: "widget-lead"
          });
        }
        if (customer && customer.id) {
          const keyword = optInKeyword();
          await setCustomerConsentStatus(
            customersClient,
            tenantId,
            customer.id,
            consentStatus,
            {
              smsConsentExpectedKeyword: keyword,
              smsConsentPromptSentAt: confirmation.sent ? new Date().toISOString() : "",
              smsConsentPromptMessageId: asString(confirmation.messageId),
              smsConsentPromptError: asString(confirmation.error)
            }
          );
        }
      } catch (confirmationError) {
        confirmation = {
          attempted: true,
          sent: false,
          simulated: false,
          status: "failed",
          messageId: "",
          error: asString(confirmationError && confirmationError.message || confirmationError).slice(0, 500)
        };
        context.log.warn("[widget-lead][sms-opt-in] lead captured but confirmation failed", {
          tenantId,
          leadId,
          error: confirmation.error
        });
      }
    } else if (isRecentPendingConsent(phoneConsent)) {
      consentStatus = "pending-confirmation";
      confirmation.status = "pending-confirmation";
      if (customer && customer.id) {
        await setCustomerConsentStatus(customersClient, tenantId, customer.id, "pending-confirmation", {
          smsConsentExpectedKeyword: asString(phoneConsent.expectedKeyword || optInKeyword()),
          smsConsentPromptSentAt: asString(phoneConsent.promptSentAt || phoneConsent.smsConsentPromptSentAt),
          smsConsentPromptMessageId: asString(phoneConsent.promptMessageId || phoneConsent.smsConsentPromptMessageId),
          smsConsentPromptError: ""
        });
      }
    }

    context.res = json(req, 200, {
      ok: true,
      source: "widget",
      tenantId,
      requestedTenantId,
      customerId: customer && customer.id ? customer.id : null,
      customerName: customer && customer.name ? customer.name : null,
      customerCreated,
      matchedBy,
      duplicateMatch: match && match.customer ? {
        candidateId: asString(match.customer.id),
        confidence: Number(match.confidence) || 0,
        score: Number(match.score) || 0,
        reasons: Array.isArray(match.reasons) ? match.reasons : [],
        action: forceReuse ? "auto-merge" : matchAction
      } : null,
      leadId,
      leadCreated,
      duplicateLeadSkipped: !leadCreated,
      laneId: leadsLane.id,
      sms: {
        optInProvided: inbound.smsOptInProvided,
        optInChecked: inbound.smsOptIn,
        consentStatus,
        confirmationAttempted: confirmation.attempted,
        confirmationSent: confirmation.sent,
        confirmationSimulated: confirmation.simulated,
        confirmationStatus: confirmation.status,
        confirmationMessageId: confirmation.messageId || null,
        confirmationError: confirmation.error || null
      }
    });
  } catch (err) {
    context.log.error("[widget-lead]", err);
    context.res = json(req, 500, {
      error: "Server error",
      detail: String((err && err.message) || err)
    });
  }
};
