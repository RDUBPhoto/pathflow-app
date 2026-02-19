const { SmsClient } = require("@azure/communication-sms");
const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

const CUSTOMERS_TABLE = "customers";
const LANES_TABLE = "lanes";
const WORKITEMS_TABLE = "workitems";
const SMS_TABLE = "smsmessages";
const SENDER_TABLE = "smssenders";
const PARTITION = "main";
const SENDER_DEFAULT_ROW_KEY = "default";

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

function isE164(value) {
  return /^\+[1-9]\d{7,14}$/.test(asString(value));
}

function isValidVin(value) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(asString(value).toUpperCase());
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
  if (Buffer.isBuffer(raw)) return parseRequestBody({ body: raw.toString("utf8") });
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

function resolveCorsOrigin(req) {
  const origin = readHeader(req && req.headers, "origin");
  if (!origin) return "";

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

async function ensureLeadsLane(lanesClient) {
  const iter = lanesClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
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
      partitionKey: PARTITION,
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
    id: asString(entity.rowKey),
    name: asString(entity.name),
    firstName: asString(entity.firstName),
    lastName: asString(entity.lastName),
    email: asString(entity.email),
    phone: asString(entity.phone),
    vin: asString(entity.vin),
    notes: asString(entity.notes),
    createdAt: asString(entity.createdAt),
    updatedAt: asString(entity.updatedAt),
    smsConsentStatus: asString(entity.smsConsentStatus)
  };
}

async function findMatchingCustomer(customersClient, inbound) {
  const targetEmail = normalizeEmail(inbound.email);
  const targetPhone = normalizePhone(inbound.phone);
  const targetName = asString(inbound.name).toLowerCase();
  if (!targetEmail && !targetPhone && !targetName) return null;

  let best = null;
  const iter = customersClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
  for await (const entity of iter) {
    const current = customerFromEntity(entity);
    let score = 0;
    const reasons = [];

    if (targetEmail && normalizeEmail(current.email) === targetEmail) {
      score += 100;
      reasons.push("email");
    }
    if (targetPhone && normalizePhone(current.phone) === targetPhone) {
      score += 80;
      reasons.push("phone");
    }
    if (targetName) {
      const currentName = asString(current.name || `${current.firstName} ${current.lastName}`.trim()).toLowerCase();
      if (currentName && currentName === targetName) {
        score += 50;
        reasons.push("name");
      }
    }
    if (!score) continue;
    if (!best || score > best.score) best = { customer: current, score, reasons };
  }

  return best;
}

function mergeNotes(existingNotes, message, sourceName) {
  const existing = asString(existingNotes);
  const inbound = asString(message);
  if (!inbound) return existing;
  const stamp = new Date().toLocaleString("en-US", { hour12: true });
  const block = `[Web Lead${sourceName ? ` - ${sourceName}` : ""} • ${stamp}]\n${inbound}`;
  if (!existing) return block;
  if (existing.includes(block)) return existing;
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

async function createCustomer(customersClient, inbound) {
  const now = new Date().toISOString();
  const id = randomUUID();
  const names = splitName(inbound.name, inbound.email);
  const fullName = asString(inbound.name) || names.fullName || asString(inbound.email) || "Website Lead";
  const entity = {
    partitionKey: PARTITION,
    rowKey: id,
    name: fullName,
    firstName: names.firstName,
    lastName: names.lastName,
    email: asString(inbound.email),
    phone: asString(inbound.phone),
    vin: asString(inbound.vin),
    notes: mergeNotes("", inbound.message, inbound.sourceName),
    leadSource: "web",
    createdAt: now,
    updatedAt: now
  };
  applyConsentFields(entity, inbound, now, initialConsentStatus(inbound));

  await customersClient.upsertEntity(entity, "Merge");

  return {
    id,
    name: fullName,
    firstName: names.firstName,
    lastName: names.lastName,
    email: asString(inbound.email),
    phone: asString(inbound.phone),
    vin: asString(inbound.vin)
  };
}

async function updateCustomerFromInbound(customersClient, customer, inbound) {
  const now = new Date().toISOString();
  const patch = {
    partitionKey: PARTITION,
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
  if (!asString(customer.phone) && asString(inbound.phone)) patch.phone = asString(inbound.phone);
  if (!asString(customer.vin) && asString(inbound.vin)) patch.vin = asString(inbound.vin);

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
}

async function setCustomerConsentStatus(customersClient, customerId, status, extra = {}) {
  if (!customerId || !status) return;
  const now = new Date().toISOString();
  await customersClient.upsertEntity(
    {
      partitionKey: PARTITION,
      rowKey: customerId,
      smsConsentStatus: status,
      smsConsentUpdatedAt: now,
      updatedAt: now,
      ...extra
    },
    "Merge"
  );
}

async function findExistingLeadForCustomer(workItemsClient, laneId, customerId) {
  const safeLane = escapedFilterValue(laneId);
  const safeCustomer = escapedFilterValue(customerId);
  const filter = `PartitionKey eq '${PARTITION}' and laneId eq '${safeLane}' and customerId eq '${safeCustomer}'`;
  const iter = workItemsClient.listEntities({ queryOptions: { filter } });

  let latest = null;
  for await (const entity of iter) {
    const createdAt = asString(entity.createdAt);
    const updatedAt = asString(entity.updatedAt);
    const ts = Date.parse(updatedAt || createdAt || "");
    if (!latest || (Number.isFinite(ts) && ts > latest.ts)) {
      latest = { id: asString(entity.rowKey), ts: Number.isFinite(ts) ? ts : 0 };
    }
  }
  return latest;
}

async function nextLaneSort(workItemsClient, laneId) {
  const safeLane = escapedFilterValue(laneId);
  const iter = workItemsClient.listEntities({
    queryOptions: { filter: `PartitionKey eq '${PARTITION}' and laneId eq '${safeLane}'` }
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

function buildLeadTitle(customer, vin) {
  const base = asString(customer && customer.name) || asString(customer && customer.email) || asString(customer && customer.phone) || "New Lead";
  const suffix = asString(vin) ? `VIN ${asString(vin)}` : "Web Lead";
  return `${base} — ${suffix}`.slice(0, 240);
}

async function createLead(workItemsClient, laneId, inbound, customer) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const sort = await nextLaneSort(workItemsClient, laneId);
  const sourceName = intakeSourceName(inbound.raw);
  await workItemsClient.upsertEntity(
    {
      partitionKey: PARTITION,
      rowKey: id,
      laneId,
      title: buildLeadTitle(customer, inbound.vin),
      customerId: customer.id,
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
      message: asString(inbound.message),
      createdAt: now,
      updatedAt: now
    },
    "Merge"
  );
  return id;
}

async function touchLead(workItemsClient, id, inbound) {
  const sourceName = intakeSourceName(inbound.raw);
  await workItemsClient.upsertEntity(
    {
      partitionKey: PARTITION,
      rowKey: id,
      updatedAt: new Date().toISOString(),
      source: "web",
      leadSource: "web",
      intakeSource: sourceName,
      origin: sourceName,
      channel: "website",
      vin: asString(inbound.vin),
      message: asString(inbound.message)
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

async function resolveSenderNumber(senderClient) {
  try {
    const configured = await senderClient.getEntity(PARTITION, SENDER_DEFAULT_ROW_KEY);
    const sender = normalizeE164(configured.fromNumber);
    if (sender) return sender;
  } catch (_) {}
  return normalizeE164(process.env.ACS_SMS_FROM);
}

function optInKeyword() {
  return asString(process.env.WIDGET_SMS_CONFIRM_KEYWORD || "START").toUpperCase();
}

function defaultOptInMessage() {
  const keyword = optInKeyword();
  const brand = asString(process.env.WIDGET_BRAND_NAME || "Pathflow");
  return `${brand}: Reply ${keyword} or YES to confirm SMS updates for your service request. Msg freq varies. Msg&data rates may apply. Reply STOP to opt out, HELP for help.`;
}

function buildOptInMessage() {
  const raw = asString(process.env.WIDGET_SMS_OPT_IN_MESSAGE);
  if (!raw) return defaultOptInMessage();
  return raw
    .replace(/\{keyword\}/gi, optInKeyword())
    .replace(/\{brand\}/gi, asString(process.env.WIDGET_BRAND_NAME || "Pathflow"));
}

function shouldSendOptInConfirmation(inbound) {
  if (!inbound.smsOptIn) return false;
  if (!inbound.phoneE164) return false;
  return asString(process.env.WIDGET_SEND_OPT_IN_CONFIRMATION || "true").toLowerCase() !== "false";
}

async function sendOptInConfirmation(to, from, message) {
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
  const response = await client.send({ from, to: [to], message });
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

async function saveSmsOutboundConfirmation(smsClient, customer, to, from, message, sendResult) {
  const now = new Date().toISOString();
  await smsClient.upsertEntity(
    {
      partitionKey: PARTITION,
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
    phone,
    phoneE164: normalizeE164(phone),
    vin,
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
      securedByApiKey: !!asString(process.env.WIDGET_API_KEY),
      accepts: ["name", "phone", "email", "vin", "message", "smsOptIn"],
      requiredFields: ["email or phone", "name (recommended)", "vin (required: 17 chars, A-HJ-NPR-Z0-9)", "smsOptIn (if phone will receive SMS)"]
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
  if (!inbound.vin) {
    context.res = json(req, 400, { error: "VIN is required." });
    return;
  }
  if (!isValidVin(inbound.vin)) {
    context.res = json(req, 400, { error: "VIN must be 17 characters and cannot include I, O, or Q." });
    return;
  }
  if (inbound.smsOptIn && !inbound.phoneE164) {
    context.res = json(req, 400, { error: "Phone must be valid when SMS opt-in is checked (E.164 or US 10-digit)." });
    return;
  }

  try {
    const customersClient = await getTableClient(CUSTOMERS_TABLE);
    const lanesClient = await getTableClient(LANES_TABLE);
    const workItemsClient = await getTableClient(WORKITEMS_TABLE);

    const match = await findMatchingCustomer(customersClient, inbound);
    let customer = null;
    let customerCreated = false;
    let matchedBy = [];

    if (match && match.customer) {
      customer = match.customer;
      matchedBy = match.reasons;
      await updateCustomerFromInbound(customersClient, match.customer, inbound);
    } else {
      customer = await createCustomer(customersClient, inbound);
      customerCreated = true;
    }

    const leadsLane = await ensureLeadsLane(lanesClient);
    const allowDuplicates = asString(process.env.WIDGET_CREATE_DUPLICATE_LEADS).toLowerCase() === "true";
    let leadId = "";
    let leadCreated = false;

    if (!allowDuplicates && customer && customer.id) {
      const existing = await findExistingLeadForCustomer(workItemsClient, leadsLane.id, customer.id);
      if (existing && existing.id) {
        leadId = existing.id;
        await touchLead(workItemsClient, leadId, inbound);
      }
    }

    if (!leadId) {
      leadId = await createLead(workItemsClient, leadsLane.id, inbound, customer);
      leadCreated = true;
    }

    let consentStatus = initialConsentStatus(inbound);
    let confirmation = {
      attempted: false,
      sent: false,
      simulated: false,
      status: "not-requested",
      messageId: "",
      error: ""
    };

    if (shouldSendOptInConfirmation(inbound)) {
      const senderClient = await getTableClient(SENDER_TABLE);
      const smsClient = await getTableClient(SMS_TABLE);
      const sender = await resolveSenderNumber(senderClient);
      const message = buildOptInMessage();
      confirmation = await sendOptInConfirmation(inbound.phoneE164, sender, message);
      if (confirmation.sent) {
        await saveSmsOutboundConfirmation(smsClient, customer, inbound.phoneE164, sender, message, confirmation);
        consentStatus = "pending-confirmation";
      }
      if (customer && customer.id) {
        const keyword = optInKeyword();
        await setCustomerConsentStatus(
          customersClient,
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
    }

    context.res = json(req, 200, {
      ok: true,
      source: "widget",
      customerId: customer && customer.id ? customer.id : null,
      customerName: customer && customer.name ? customer.name : null,
      customerCreated,
      matchedBy,
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
