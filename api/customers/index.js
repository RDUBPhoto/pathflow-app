// api/customers/index.js
const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

const TABLE = "customers";
const NOT_DUPLICATES_TABLE = "customernotduplicates";
const PARTITION = "main";
const DUPLICATE_REASON_WEIGHTS = Object.freeze({
  vin: 45,
  email: 30,
  phone: 15,
  name: 10
});
const DUPLICATE_MAX_SCORE = Object.values(DUPLICATE_REASON_WEIGHTS).reduce((sum, value) => sum + Number(value || 0), 0) || 100;
const DUPLICATE_AUTO_MERGE_THRESHOLD = 80;
const DUPLICATE_REVIEW_THRESHOLD = 55;
const CUSTOMER_FIELDS = [
  "business",
  "accountManager",
  "creator",
  "position",
  "title",
  "name",
  "firstName",
  "lastName",
  "phone",
  "mobile",
  "email",
  "secondaryEmail",
  "address",
  "address1",
  "address2",
  "address3",
  "town",
  "county",
  "state",
  "postcode",
  "country",
  "accountReference",
  "priceList",
  "paymentTerm",
  "lastQuoteActivity",
  "lastJobActivity",
  "lastInvoiceActivity",
  "lastOpportunityActivity",
  "lastTaskActivity",
  "dateLeft",
  "tags",
  "contactTags",
  "vin",
  "vehicleMake",
  "vehicleModel",
  "vehicleYear",
  "vehicleTrim",
  "vehicleDoors",
  "bedLength",
  "cabType",
  "engineModel",
  "engineCylinders",
  "transmissionStyle",
  "boltPattern",
  "rearBoltPattern",
  "pcd",
  "rearPcd",
  "centreBore",
  "wheelFasteners",
  "wheelTorque",
  "frontTireSize",
  "rearTireSize",
  "frontRimSize",
  "rearRimSize",
  "vehicleColor",
  "smsConsentStatus",
  "smsConsentProvidedAt",
  "smsConsentConfirmedAt",
  "smsConsentRevokedAt",
  "smsConsentPromptSentAt",
  "smsConsentPromptMessageId",
  "smsConsentPromptError",
  "smsConsentExpectedKeyword",
  "smsConsentMethod",
  "smsConsentSource",
  "smsConsentVersion",
  "smsConsentText",
  "smsConsentPageUrl",
  "smsConsentIp",
  "smsConsentKeyword",
  "smsConsentLastKeywordAt",
  "smsConsentUpdatedAt",
  "notes",
  "createdAt",
  "updatedAt"
];
const RELATED_CUSTOMER_TABLES = [
  { table: "workitems", includeCustomerName: false },
  { table: "schedule", includeCustomerName: false },
  { table: "smsmessages", includeCustomerName: true },
  { table: "emailmessages", includeCustomerName: true },
  { table: "inventoryneeds", includeCustomerName: true }
];

function toStr(v) { return v == null ? "" : String(v); }
function pick(b, k) { return toStr(b[k]).trim(); }
function setIfPresent(target, body, key) { if (Object.prototype.hasOwnProperty.call(body, key)) target[key] = pick(body, key); }
function escapedFilterValue(value) { return toStr(value).replace(/'/g, "''"); }
function parseJsonRaw(raw) {
  const text = toStr(raw).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseBody(reqBody, rawBody) {
  if (reqBody == null) {
    return rawBody == null ? {} : parseJsonRaw(rawBody);
  }

  if (Buffer.isBuffer(reqBody)) {
    return parseJsonRaw(reqBody.toString("utf8"));
  }

  if (typeof reqBody === "string") {
    return parseJsonRaw(reqBody);
  }

  if (typeof reqBody === "object") {
    // Azure/SWA can sometimes provide body as a Buffer-like shape.
    if (reqBody.type === "Buffer" && Array.isArray(reqBody.data)) {
      try {
        return parseJsonRaw(Buffer.from(reqBody.data).toString("utf8"));
      } catch {
        return null;
      }
    }
    return reqBody;
  }

  return {};
}

function normalizeEmail(value) {
  return toStr(value).trim().toLowerCase();
}

function normalizePhone(value) {
  const digits = toStr(value).replace(/\D+/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  if (digits.length > 10) return digits.slice(-10);
  return digits;
}

function normalizeName(value) {
  return toStr(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeVin(value) {
  const cleaned = toStr(value).toUpperCase().replace(/\s+/g, "");
  if (!cleaned) return "";
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(cleaned) ? cleaned : "";
}

function fullName(firstName, lastName, name) {
  const explicit = toStr(name).trim();
  if (explicit) return explicit;
  return `${toStr(firstName).trim()} ${toStr(lastName).trim()}`.trim();
}

function normalizedEmailList(primary, secondary) {
  const list = [normalizeEmail(primary), normalizeEmail(secondary)].filter(Boolean);
  return Array.from(new Set(list));
}

function duplicatePairKey(leftId, rightId) {
  const a = toStr(leftId).trim();
  const b = toStr(rightId).trim();
  if (!a || !b || a === b) return "";
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}

function toCustomerDto(entity) {
  return {
    id: toStr(entity.rowKey),
    business: toStr(entity.business),
    accountManager: toStr(entity.accountManager),
    creator: toStr(entity.creator),
    position: toStr(entity.position),
    title: toStr(entity.title),
    name: toStr(entity.name),
    firstName: toStr(entity.firstName),
    lastName: toStr(entity.lastName),
    phone: toStr(entity.phone),
    mobile: toStr(entity.mobile),
    email: toStr(entity.email),
    secondaryEmail: toStr(entity.secondaryEmail),
    address: toStr(entity.address),
    address1: toStr(entity.address1),
    address2: toStr(entity.address2),
    address3: toStr(entity.address3),
    town: toStr(entity.town),
    county: toStr(entity.county),
    state: toStr(entity.state),
    postcode: toStr(entity.postcode),
    country: toStr(entity.country),
    accountReference: toStr(entity.accountReference),
    priceList: toStr(entity.priceList),
    paymentTerm: toStr(entity.paymentTerm),
    lastQuoteActivity: toStr(entity.lastQuoteActivity),
    lastJobActivity: toStr(entity.lastJobActivity),
    lastInvoiceActivity: toStr(entity.lastInvoiceActivity),
    lastOpportunityActivity: toStr(entity.lastOpportunityActivity),
    lastTaskActivity: toStr(entity.lastTaskActivity),
    dateLeft: toStr(entity.dateLeft),
    tags: toStr(entity.tags),
    contactTags: toStr(entity.contactTags),
    vin: toStr(entity.vin),
    vehicleMake: toStr(entity.vehicleMake),
    vehicleModel: toStr(entity.vehicleModel),
    vehicleYear: toStr(entity.vehicleYear),
    vehicleTrim: toStr(entity.vehicleTrim),
    vehicleDoors: toStr(entity.vehicleDoors),
    bedLength: toStr(entity.bedLength),
    cabType: toStr(entity.cabType),
    engineModel: toStr(entity.engineModel),
    engineCylinders: toStr(entity.engineCylinders),
    transmissionStyle: toStr(entity.transmissionStyle),
    boltPattern: toStr(entity.boltPattern),
    rearBoltPattern: toStr(entity.rearBoltPattern),
    pcd: toStr(entity.pcd),
    rearPcd: toStr(entity.rearPcd),
    centreBore: toStr(entity.centreBore),
    wheelFasteners: toStr(entity.wheelFasteners),
    wheelTorque: toStr(entity.wheelTorque),
    frontTireSize: toStr(entity.frontTireSize),
    rearTireSize: toStr(entity.rearTireSize),
    frontRimSize: toStr(entity.frontRimSize),
    rearRimSize: toStr(entity.rearRimSize),
    vehicleColor: toStr(entity.vehicleColor),
    smsConsentStatus: toStr(entity.smsConsentStatus),
    smsConsentProvidedAt: toStr(entity.smsConsentProvidedAt),
    smsConsentConfirmedAt: toStr(entity.smsConsentConfirmedAt),
    smsConsentRevokedAt: toStr(entity.smsConsentRevokedAt),
    smsConsentPromptSentAt: toStr(entity.smsConsentPromptSentAt),
    smsConsentPromptMessageId: toStr(entity.smsConsentPromptMessageId),
    smsConsentPromptError: toStr(entity.smsConsentPromptError),
    smsConsentExpectedKeyword: toStr(entity.smsConsentExpectedKeyword),
    smsConsentMethod: toStr(entity.smsConsentMethod),
    smsConsentSource: toStr(entity.smsConsentSource),
    smsConsentVersion: toStr(entity.smsConsentVersion),
    smsConsentText: toStr(entity.smsConsentText),
    smsConsentPageUrl: toStr(entity.smsConsentPageUrl),
    smsConsentIp: toStr(entity.smsConsentIp),
    smsConsentKeyword: toStr(entity.smsConsentKeyword),
    smsConsentLastKeywordAt: toStr(entity.smsConsentLastKeywordAt),
    smsConsentUpdatedAt: toStr(entity.smsConsentUpdatedAt),
    notes: toStr(entity.notes),
    createdAt: toStr(entity.createdAt),
    updatedAt: toStr(entity.updatedAt)
  };
}

function importAddressFromParts(row) {
  const parts = [
    toStr(row.address1).trim(),
    toStr(row.address2).trim(),
    toStr(row.address3).trim(),
    toStr(row.town).trim(),
    toStr(row.state).trim(),
    toStr(row.postcode).trim(),
    toStr(row.country).trim()
  ].filter(Boolean);
  return parts.join(", ");
}

function findExistingByIdentity(customers, row) {
  const probe = {
    emails: normalizedEmailList(row.email, row.secondaryEmail),
    phone: normalizePhone(row.phone || row.mobile),
    name: normalizeName(fullName(row.firstName, row.lastName, row.name))
  };
  if (!probe.emails.length && !probe.phone && !probe.name) return null;
  let best = null;
  let bestScore = 0;
  for (const customer of customers) {
    let score = 0;
    if (probe.emails.length) {
      const candidateEmails = normalizedEmailList(customer.email, customer.secondaryEmail);
      if (candidateEmails.some(value => probe.emails.includes(value))) score += 100;
    }
    if (probe.phone) {
      const candidatePhone = normalizePhone(customer.phone || customer.mobile);
      if (candidatePhone && candidatePhone === probe.phone) score += 80;
    }
    if (probe.name) {
      const candidateName = normalizeName(fullName(customer.firstName, customer.lastName, customer.name));
      if (candidateName && candidateName === probe.name) score += 50;
    }
    if (score > bestScore) {
      best = customer;
      bestScore = score;
    }
  }
  return bestScore >= 80 ? best : null;
}

async function listCustomers(client) {
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
  for await (const entity of iter) out.push(toCustomerDto(entity));
  return out;
}

async function getCustomerEntity(client, id) {
  const rowKey = toStr(id).trim();
  if (!rowKey) return null;
  try {
    return await client.getEntity(PARTITION, rowKey);
  } catch {
    return null;
  }
}

async function listIgnoredDuplicateKeys(conn) {
  const ignoredClient = TableClient.fromConnectionString(conn, NOT_DUPLICATES_TABLE);
  try { await ignoredClient.createTable(); } catch (_) {}
  const out = new Set();
  const iter = ignoredClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
  for await (const entity of iter) {
    const key = toStr(entity.rowKey).trim();
    if (key) out.add(key);
  }
  return out;
}

async function saveIgnoredDuplicate(conn, leftId, rightId) {
  const key = duplicatePairKey(leftId, rightId);
  if (!key) return false;
  const ignoredClient = TableClient.fromConnectionString(conn, NOT_DUPLICATES_TABLE);
  try { await ignoredClient.createTable(); } catch (_) {}
  const [a, b] = key.split("::");
  await ignoredClient.upsertEntity({
    partitionKey: PARTITION,
    rowKey: key,
    leftId: a,
    rightId: b,
    updatedAt: new Date().toISOString()
  }, "Merge");
  return true;
}

function probeFromBody(body) {
  const name = normalizeName(fullName(pick(body, "firstName"), pick(body, "lastName"), pick(body, "name")));
  const emails = normalizedEmailList(pick(body, "email"), pick(body, "secondaryEmail"));
  const phone = normalizePhone(pick(body, "phone") || pick(body, "mobile"));
  const vin = normalizeVin(pick(body, "vin"));
  return { name, emails, phone, vin };
}

function duplicateRecommendation(score) {
  const confidence = Math.max(0, Math.min(100, Math.round((Number(score) / DUPLICATE_MAX_SCORE) * 100)));
  if (confidence >= DUPLICATE_AUTO_MERGE_THRESHOLD) return { confidence, action: "auto-merge" };
  if (confidence >= DUPLICATE_REVIEW_THRESHOLD) return { confidence, action: "review" };
  return { confidence, action: "no-match" };
}

function buildDuplicateCandidates(customers, probe, excludeId, ignoredKeys) {
  const excluded = toStr(excludeId).trim();
  const out = [];
  for (const customer of customers) {
    const candidateId = toStr(customer.id);
    if (!candidateId || candidateId === excluded) continue;
    if (excluded && ignoredKeys && ignoredKeys.has(duplicatePairKey(excluded, candidateId))) continue;
    const reasons = [];
    let score = 0;

    if (probe.vin && normalizeVin(customer.vin) === probe.vin) {
      reasons.push("vin");
      score += DUPLICATE_REASON_WEIGHTS.vin;
    }
    const candidateEmails = normalizedEmailList(customer.email, customer.secondaryEmail);
    if (probe.emails.length && candidateEmails.some(value => probe.emails.includes(value))) {
      reasons.push("email");
      score += DUPLICATE_REASON_WEIGHTS.email;
    }
    if (probe.phone && normalizePhone(customer.phone) === probe.phone) {
      reasons.push("phone");
      score += DUPLICATE_REASON_WEIGHTS.phone;
    }
    if (!reasons.includes("phone") && probe.phone && normalizePhone(customer.mobile) === probe.phone) {
      reasons.push("phone");
      score += DUPLICATE_REASON_WEIGHTS.phone;
    }
    const candidateName = normalizeName(fullName(customer.firstName, customer.lastName, customer.name));
    if (probe.name && candidateName && candidateName === probe.name) {
      reasons.push("name");
      score += DUPLICATE_REASON_WEIGHTS.name;
    }
    if (!reasons.length) continue;
    const recommendation = duplicateRecommendation(score);

    out.push({
      id: candidateId,
      name: fullName(customer.firstName, customer.lastName, customer.name),
      firstName: toStr(customer.firstName),
      lastName: toStr(customer.lastName),
      email: toStr(customer.email),
      secondaryEmail: toStr(customer.secondaryEmail),
      phone: toStr(customer.phone),
      score,
      confidence: recommendation.confidence,
      recommendation: recommendation.action,
      reasons
    });
  }

  out.sort((a, b) =>
    b.score - a.score ||
    String(a.name || "").localeCompare(String(b.name || "")) ||
    String(a.id).localeCompare(String(b.id))
  );
  return out;
}

function addToGroup(groups, key, customerId) {
  if (!key || !customerId) return;
  const existing = groups.get(key);
  if (existing) {
    existing.push(customerId);
    return;
  }
  groups.set(key, [customerId]);
}

function addPairReason(pairMap, leftId, rightId, reason, scoreIncrement) {
  const a = leftId < rightId ? leftId : rightId;
  const b = leftId < rightId ? rightId : leftId;
  const key = `${a}::${b}`;
  const existing = pairMap.get(key);
  if (!existing) {
    pairMap.set(key, {
      leftId: a,
      rightId: b,
      reasons: [reason],
      score: scoreIncrement
    });
    return;
  }

  if (!existing.reasons.includes(reason)) {
    existing.reasons.push(reason);
    existing.score += scoreIncrement;
  }
}

function addPairsFromGroups(pairMap, groups, reason, scoreIncrement) {
  for (const ids of groups.values()) {
    if (!Array.isArray(ids) || ids.length < 2) continue;
    for (let i = 0; i < ids.length; i += 1) {
      const leftId = toStr(ids[i]).trim();
      if (!leftId) continue;
      for (let j = i + 1; j < ids.length; j += 1) {
        const rightId = toStr(ids[j]).trim();
        if (!rightId || rightId === leftId) continue;
        addPairReason(pairMap, leftId, rightId, reason, scoreIncrement);
      }
    }
  }
}

function duplicateSummaryCustomerPreview(customer) {
  return {
    id: toStr(customer.id),
    name: toStr(customer.name),
    firstName: toStr(customer.firstName),
    lastName: toStr(customer.lastName),
    email: toStr(customer.email),
    secondaryEmail: toStr(customer.secondaryEmail),
    phone: toStr(customer.phone),
    mobile: toStr(customer.mobile),
    address: toStr(customer.address),
    vehicleYear: toStr(customer.vehicleYear),
    vehicleMake: toStr(customer.vehicleMake),
    vehicleModel: toStr(customer.vehicleModel),
    notes: toStr(customer.notes)
  };
}

function buildDuplicateSummary(customers, limit, includeCustomers, ignoredKeys) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 200));
  const ids = new Set();
  const emails = new Map();
  const phones = new Map();
  const names = new Map();
  const vins = new Map();

  for (const customer of customers) {
    const customerId = toStr(customer.id).trim();
    if (!customerId || ids.has(customerId)) continue;
    ids.add(customerId);

    const emailsForCustomer = normalizedEmailList(customer.email, customer.secondaryEmail);
    const phone = normalizePhone(customer.phone || customer.mobile);
    const name = normalizeName(fullName(customer.firstName, customer.lastName, customer.name));
    const vin = normalizeVin(customer.vin);

    for (const email of emailsForCustomer) {
      addToGroup(emails, email, customerId);
    }
    addToGroup(phones, phone, customerId);
    addToGroup(names, name, customerId);
    addToGroup(vins, vin, customerId);
  }

  const pairMap = new Map();
  addPairsFromGroups(pairMap, vins, "vin", DUPLICATE_REASON_WEIGHTS.vin);
  addPairsFromGroups(pairMap, emails, "email", DUPLICATE_REASON_WEIGHTS.email);
  addPairsFromGroups(pairMap, phones, "phone", DUPLICATE_REASON_WEIGHTS.phone);
  addPairsFromGroups(pairMap, names, "name", DUPLICATE_REASON_WEIGHTS.name);

  let pairs = Array.from(pairMap.values());
  if (ignoredKeys && ignoredKeys.size) {
    pairs = pairs.filter(pair => !ignoredKeys.has(duplicatePairKey(pair.leftId, pair.rightId)));
  }
  pairs = pairs.map(pair => {
    const recommendation = duplicateRecommendation(pair.score);
    return {
      ...pair,
      confidence: recommendation.confidence,
      recommendation: recommendation.action
    };
  });
  pairs.sort((a, b) =>
    b.score - a.score ||
    a.leftId.localeCompare(b.leftId) ||
    a.rightId.localeCompare(b.rightId)
  );
  const topPairs = pairs.slice(0, safeLimit);
  let customersById = undefined;
  if (includeCustomers) {
    const idsForResponse = new Set();
    for (const pair of topPairs) {
      idsForResponse.add(pair.leftId);
      idsForResponse.add(pair.rightId);
    }
    customersById = {};
    for (const customer of customers) {
      const customerId = toStr(customer.id).trim();
      if (!customerId || !idsForResponse.has(customerId)) continue;
      customersById[customerId] = duplicateSummaryCustomerPreview(customer);
    }
  }

  return {
    total: pairs.length,
    pairs: topPairs,
    customersById
  };
}

function earliestTimestamp(a, b) {
  const ta = Date.parse(toStr(a));
  const tb = Date.parse(toStr(b));
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta < tb ? toStr(a) : toStr(b);
  if (Number.isFinite(ta)) return toStr(a);
  if (Number.isFinite(tb)) return toStr(b);
  return "";
}

function combineNotes(targetNotes, sourceNotes) {
  const target = toStr(targetNotes).trim();
  const source = toStr(sourceNotes).trim();
  if (!target) return source;
  if (!source) return target;
  if (target === source) return target;
  return `${target}\n\n${source}`;
}

function buildMergePatch(targetEntity, sourceEntity) {
  const now = new Date().toISOString();
  const patch = {
    partitionKey: PARTITION,
    rowKey: toStr(targetEntity.rowKey),
    updatedAt: now
  };

  for (const field of CUSTOMER_FIELDS) {
    if (field === "createdAt" || field === "updatedAt" || field === "notes") continue;
    const targetValue = toStr(targetEntity[field]).trim();
    const sourceValue = toStr(sourceEntity[field]).trim();
    if (!targetValue && sourceValue) patch[field] = sourceValue;
  }

  const targetPrimary = normalizeEmail(patch.email != null ? patch.email : targetEntity.email);
  const targetSecondary = normalizeEmail(patch.secondaryEmail != null ? patch.secondaryEmail : targetEntity.secondaryEmail);
  const sourcePrimary = normalizeEmail(sourceEntity.email);
  const sourceSecondary = normalizeEmail(sourceEntity.secondaryEmail);
  if (!targetSecondary) {
    if (sourcePrimary && sourcePrimary !== targetPrimary) {
      patch.secondaryEmail = sourcePrimary;
    } else if (sourceSecondary && sourceSecondary !== targetPrimary) {
      patch.secondaryEmail = sourceSecondary;
    }
  }

  const mergedNotes = combineNotes(targetEntity.notes, sourceEntity.notes);
  if (toStr(mergedNotes).trim() !== toStr(targetEntity.notes).trim()) patch.notes = mergedNotes;

  const finalFirst = toStr(patch.firstName != null ? patch.firstName : targetEntity.firstName).trim();
  const finalLast = toStr(patch.lastName != null ? patch.lastName : targetEntity.lastName).trim();
  const finalName = toStr(patch.name != null ? patch.name : targetEntity.name).trim();
  if (!finalName && (finalFirst || finalLast)) patch.name = `${finalFirst} ${finalLast}`.trim();

  const nextCreated = earliestTimestamp(targetEntity.createdAt, sourceEntity.createdAt);
  if (!toStr(targetEntity.createdAt).trim() && nextCreated) {
    patch.createdAt = nextCreated;
  } else if (nextCreated && nextCreated !== toStr(targetEntity.createdAt).trim()) {
    patch.createdAt = nextCreated;
  }

  return patch;
}

function mergedCustomerName(targetEntity, appliedPatch) {
  const first = toStr(appliedPatch.firstName != null ? appliedPatch.firstName : targetEntity.firstName).trim();
  const last = toStr(appliedPatch.lastName != null ? appliedPatch.lastName : targetEntity.lastName).trim();
  const name = toStr(appliedPatch.name != null ? appliedPatch.name : targetEntity.name).trim();
  return fullName(first, last, name);
}

async function remapCustomerReferences(conn, sourceId, targetId, targetName) {
  const stats = {};
  const sourceFilter = escapedFilterValue(sourceId);
  const now = new Date().toISOString();

  for (const mapping of RELATED_CUSTOMER_TABLES) {
    const client = TableClient.fromConnectionString(conn, mapping.table);
    try { await client.createTable(); } catch (_) {}
    const iter = client.listEntities({
      queryOptions: { filter: `PartitionKey eq '${PARTITION}' and customerId eq '${sourceFilter}'` }
    });

    let updated = 0;
    for await (const entity of iter) {
      const patch = {
        partitionKey: PARTITION,
        rowKey: entity.rowKey,
        customerId: targetId,
        updatedAt: now
      };
      if (mapping.includeCustomerName && targetName) patch.customerName = targetName;
      await client.upsertEntity(patch, "Merge");
      updated += 1;
    }
    stats[mapping.table] = updated;
  }

  return stats;
}

module.exports = async function (context, req) {
  const method = (req.method || "GET").toUpperCase();
  if (method === "OPTIONS") { context.res = { status: 204 }; return; }

  try {
    const conn = process.env.STORAGE_CONNECTION_STRING;
    if (!conn) { context.res = { status: 500, body: { error: "Missing STORAGE_CONNECTION_STRING" } }; return; }

    const client = TableClient.fromConnectionString(conn, TABLE);
    try { await client.createTable(); } catch (_) {}

    if (method === "GET") {
      const out = await listCustomers(client);
      context.res = { status: 200, headers: { "content-type": "application/json" }, body: out };
      return;
    }

    if (method === "POST") {
      const parsedBody = parseBody(req.body, req.rawBody);
      if (parsedBody == null) {
        context.res = {
          status: 400,
          headers: { "content-type": "application/json" },
          body: { error: "Invalid request payload. Please retry import." }
        };
        return;
      }
      const b = Array.isArray(parsedBody) ? { op: "import", rows: parsedBody } : parsedBody;
      const op = String(b.op || (Array.isArray(b.rows) ? "import" : "")).toLowerCase();
      const id = toStr(b.id);

      if (op === "delete" && id) {
        await client.deleteEntity(PARTITION, id);
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
        return;
      }

      if (op === "findduplicates" || op === "duplicatecheck" || op === "checkduplicates") {
        const probe = probeFromBody(b);
        if (!probe.emails.length && !probe.phone && !probe.name && !probe.vin) {
          context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, items: [] } };
          return;
        }
        const customers = await listCustomers(client);
        const excludeId = toStr(b.excludeId || b.id);
        const ignoredKeys = excludeId ? await listIgnoredDuplicateKeys(conn) : new Set();
        const items = buildDuplicateCandidates(customers, probe, excludeId, ignoredKeys);
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, items } };
        return;
      }

      if (op === "duplicatesummary" || op === "duplicates") {
        const customers = await listCustomers(client);
        const includeCustomers = b.includeCustomers === true || toStr(b.includeCustomers).toLowerCase() === "true";
        const ignoredKeys = await listIgnoredDuplicateKeys(conn);
        const summary = buildDuplicateSummary(customers, b.limit, includeCustomers, ignoredKeys);
        context.res = {
          status: 200,
          headers: { "content-type": "application/json" },
          body: {
            ok: true,
            total: summary.total,
            pairs: summary.pairs,
            customersById: summary.customersById || {}
          }
        };
        return;
      }

      if (op === "marknotduplicate" || op === "notduplicate") {
        const leftId = toStr(b.leftId).trim();
        const rightId = toStr(b.rightId).trim();
        if (!leftId || !rightId || leftId === rightId) {
          context.res = {
            status: 400,
            headers: { "content-type": "application/json" },
            body: { error: "leftId and rightId are required." }
          };
          return;
        }
        await saveIgnoredDuplicate(conn, leftId, rightId);
        context.res = {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { ok: true }
        };
        return;
      }

      if (op === "mergedraft" || op === "merge-draft") {
        const targetId = toStr(b.targetId || b.id).trim();
        if (!targetId) {
          context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "targetId required" } };
          return;
        }
        const targetEntity = await getCustomerEntity(client, targetId);
        if (!targetEntity) {
          context.res = { status: 404, headers: { "content-type": "application/json" }, body: { error: "Target customer not found." } };
          return;
        }
        const sourceDraft = { ...b };
        sourceDraft.name = fullName(pick(b, "firstName"), pick(b, "lastName"), pick(b, "name"));
        const patch = buildMergePatch(targetEntity, sourceDraft);
        await client.upsertEntity(patch, "Merge");
        const merged = await getCustomerEntity(client, targetId);
        context.res = {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { ok: true, merged: true, id: targetId, remapped: {}, sourceDeleted: false, customer: toCustomerDto(merged || targetEntity) }
        };
        return;
      }

      if (op === "merge") {
        const sourceId = toStr(b.sourceId).trim();
        const targetId = toStr(b.targetId).trim();
        if (!sourceId || !targetId) {
          context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "sourceId and targetId required" } };
          return;
        }
        if (sourceId === targetId) {
          context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "sourceId and targetId must be different." } };
          return;
        }

        const sourceEntity = await getCustomerEntity(client, sourceId);
        const targetEntity = await getCustomerEntity(client, targetId);
        if (!sourceEntity || !targetEntity) {
          context.res = { status: 404, headers: { "content-type": "application/json" }, body: { error: "Source or target customer was not found." } };
          return;
        }

        const patch = buildMergePatch(targetEntity, sourceEntity);
        await client.upsertEntity(patch, "Merge");
        const targetName = mergedCustomerName(targetEntity, patch);
        const remapped = await remapCustomerReferences(conn, sourceId, targetId, targetName);
        await client.deleteEntity(PARTITION, sourceId);
        const merged = await getCustomerEntity(client, targetId);
        context.res = {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { ok: true, merged: true, id: targetId, remapped, sourceDeleted: true, customer: toCustomerDto(merged || targetEntity) }
        };
        return;
      }

      if (op === "import") {
        const rows = Array.isArray(b.rows) ? b.rows : [];
        if (!rows.length) {
          context.res = {
            status: 400,
            headers: { "content-type": "application/json" },
            body: { error: "rows required" }
          };
          return;
        }

        const existingCustomers = await listCustomers(client);
        let created = 0;
        let updated = 0;
        let skipped = 0;
        const errors = [];

        for (let i = 0; i < rows.length; i += 1) {
          const source = rows[i] || {};
          try {
            const firstName = pick(source, "firstName");
            const lastName = pick(source, "lastName");
            const name = fullName(firstName, lastName, pick(source, "name"));
            const email = pick(source, "email");
            const secondaryEmail = pick(source, "secondaryEmail");
            const phone = pick(source, "phone");
            const mobile = pick(source, "mobile");
            const primaryPhone = phone || mobile;
            const address = pick(source, "address") || importAddressFromParts(source);
            const fallbackName = name || pick(source, "business") || email || secondaryEmail || primaryPhone;

            if (!fallbackName && !email && !primaryPhone) {
              skipped += 1;
              continue;
            }

            const existing = findExistingByIdentity(existingCustomers, {
              name: fallbackName,
              firstName,
              lastName,
              email,
              secondaryEmail,
              phone: primaryPhone,
              mobile
            });

            if (!existing) {
              const rowKey = randomUUID();
              const now = new Date().toISOString();
              const entity = {
                partitionKey: PARTITION,
                rowKey,
                business: pick(source, "business"),
                accountManager: pick(source, "accountManager"),
                creator: pick(source, "creator"),
                position: pick(source, "position"),
                title: pick(source, "title"),
                name: fallbackName,
                firstName,
                lastName,
                phone: primaryPhone,
                mobile,
                email,
                secondaryEmail,
                address,
                address1: pick(source, "address1"),
                address2: pick(source, "address2"),
                address3: pick(source, "address3"),
                town: pick(source, "town"),
                county: pick(source, "county"),
                state: pick(source, "state"),
                postcode: pick(source, "postcode"),
                country: pick(source, "country"),
                accountReference: pick(source, "accountReference"),
                priceList: pick(source, "priceList"),
                paymentTerm: pick(source, "paymentTerm"),
                lastQuoteActivity: pick(source, "lastQuoteActivity"),
                lastJobActivity: pick(source, "lastJobActivity"),
                lastInvoiceActivity: pick(source, "lastInvoiceActivity"),
                lastOpportunityActivity: pick(source, "lastOpportunityActivity"),
                lastTaskActivity: pick(source, "lastTaskActivity"),
                dateLeft: pick(source, "dateLeft"),
                tags: pick(source, "tags"),
                contactTags: pick(source, "contactTags"),
                notes: pick(source, "notes"),
                createdAt: pick(source, "createdAt") || now,
                updatedAt: now
              };
              await client.upsertEntity(entity, "Merge");
              existingCustomers.push(toCustomerDto(entity));
              created += 1;
              continue;
            }

            const patch = {
              partitionKey: PARTITION,
              rowKey: toStr(existing.id),
              updatedAt: new Date().toISOString()
            };

            const mergeValue = (key, value) => {
              const incoming = toStr(value).trim();
              if (!incoming) return;
              const current = toStr(existing[key]).trim();
              if (!current) patch[key] = incoming;
            };

            mergeValue("business", source.business);
            mergeValue("accountManager", source.accountManager);
            mergeValue("creator", source.creator);
            mergeValue("position", source.position);
            mergeValue("title", source.title);
            mergeValue("name", fallbackName);
            mergeValue("firstName", firstName);
            mergeValue("lastName", lastName);
            mergeValue("phone", primaryPhone);
            mergeValue("mobile", mobile);
            mergeValue("email", email);
            mergeValue("secondaryEmail", secondaryEmail);
            mergeValue("address", address);
            mergeValue("address1", source.address1);
            mergeValue("address2", source.address2);
            mergeValue("address3", source.address3);
            mergeValue("town", source.town);
            mergeValue("county", source.county);
            mergeValue("state", source.state);
            mergeValue("postcode", source.postcode);
            mergeValue("country", source.country);
            mergeValue("accountReference", source.accountReference);
            mergeValue("priceList", source.priceList);
            mergeValue("paymentTerm", source.paymentTerm);
            mergeValue("lastQuoteActivity", source.lastQuoteActivity);
            mergeValue("lastJobActivity", source.lastJobActivity);
            mergeValue("lastInvoiceActivity", source.lastInvoiceActivity);
            mergeValue("lastOpportunityActivity", source.lastOpportunityActivity);
            mergeValue("lastTaskActivity", source.lastTaskActivity);
            mergeValue("dateLeft", source.dateLeft);
            mergeValue("tags", source.tags);
            mergeValue("contactTags", source.contactTags);

            const mergedNotes = combineNotes(existing.notes, source.notes);
            if (mergedNotes && mergedNotes !== toStr(existing.notes).trim()) {
              patch.notes = mergedNotes;
            }

            const keys = Object.keys(patch);
            if (keys.length <= 3) {
              skipped += 1;
              continue;
            }
            await client.upsertEntity(patch, "Merge");
            updated += 1;
          } catch (err) {
            errors.push({ index: i, error: String((err && err.message) || err) });
          }
        }

        context.res = {
          status: 200,
          headers: { "content-type": "application/json" },
          body: { ok: true, created, updated, skipped, errors }
        };
        return;
      }

      const name = pick(b, "name");
      const phone = pick(b, "phone");
      const email = pick(b, "email");
      const secondaryEmail = pick(b, "secondaryEmail");

      if (!id && !name) {
        context.res = {
          status: 400,
          headers: { "content-type": "application/json" },
          body: { error: "Name is required when creating a single customer." }
        };
        return;
      }

      if (!id) {
        const rowKey = randomUUID();
        const createdAt = toStr(b.createdAt) || new Date().toISOString();
        const entity = {
          partitionKey: PARTITION,
          rowKey,
          business: pick(b, "business"),
          accountManager: pick(b, "accountManager"),
          creator: pick(b, "creator"),
          position: pick(b, "position"),
          title: pick(b, "title"),
          name,
          firstName: pick(b, "firstName"),
          lastName: pick(b, "lastName"),
          phone,
          mobile: pick(b, "mobile"),
          email,
          secondaryEmail,
          address: pick(b, "address"),
          address1: pick(b, "address1"),
          address2: pick(b, "address2"),
          address3: pick(b, "address3"),
          town: pick(b, "town"),
          county: pick(b, "county"),
          state: pick(b, "state"),
          postcode: pick(b, "postcode"),
          country: pick(b, "country"),
          accountReference: pick(b, "accountReference"),
          priceList: pick(b, "priceList"),
          paymentTerm: pick(b, "paymentTerm"),
          lastQuoteActivity: pick(b, "lastQuoteActivity"),
          lastJobActivity: pick(b, "lastJobActivity"),
          lastInvoiceActivity: pick(b, "lastInvoiceActivity"),
          lastOpportunityActivity: pick(b, "lastOpportunityActivity"),
          lastTaskActivity: pick(b, "lastTaskActivity"),
          dateLeft: pick(b, "dateLeft"),
          tags: pick(b, "tags"),
          contactTags: pick(b, "contactTags"),
          vin: pick(b, "vin"),
          vehicleMake: pick(b, "vehicleMake"),
          vehicleModel: pick(b, "vehicleModel"),
          vehicleYear: pick(b, "vehicleYear"),
          vehicleTrim: pick(b, "vehicleTrim"),
          vehicleDoors: pick(b, "vehicleDoors"),
          bedLength: pick(b, "bedLength"),
          cabType: pick(b, "cabType"),
          engineModel: pick(b, "engineModel"),
          engineCylinders: pick(b, "engineCylinders"),
          transmissionStyle: pick(b, "transmissionStyle"),
          boltPattern: pick(b, "boltPattern"),
          rearBoltPattern: pick(b, "rearBoltPattern"),
          pcd: pick(b, "pcd"),
          rearPcd: pick(b, "rearPcd"),
          centreBore: pick(b, "centreBore"),
          wheelFasteners: pick(b, "wheelFasteners"),
          wheelTorque: pick(b, "wheelTorque"),
          frontTireSize: pick(b, "frontTireSize"),
          rearTireSize: pick(b, "rearTireSize"),
          frontRimSize: pick(b, "frontRimSize"),
          rearRimSize: pick(b, "rearRimSize"),
          vehicleColor: pick(b, "vehicleColor"),
          smsConsentStatus: pick(b, "smsConsentStatus"),
          smsConsentProvidedAt: pick(b, "smsConsentProvidedAt"),
          smsConsentConfirmedAt: pick(b, "smsConsentConfirmedAt"),
          smsConsentRevokedAt: pick(b, "smsConsentRevokedAt"),
          smsConsentPromptSentAt: pick(b, "smsConsentPromptSentAt"),
          smsConsentPromptMessageId: pick(b, "smsConsentPromptMessageId"),
          smsConsentPromptError: pick(b, "smsConsentPromptError"),
          smsConsentExpectedKeyword: pick(b, "smsConsentExpectedKeyword"),
          smsConsentMethod: pick(b, "smsConsentMethod"),
          smsConsentSource: pick(b, "smsConsentSource"),
          smsConsentVersion: pick(b, "smsConsentVersion"),
          smsConsentText: pick(b, "smsConsentText"),
          smsConsentPageUrl: pick(b, "smsConsentPageUrl"),
          smsConsentIp: pick(b, "smsConsentIp"),
          smsConsentKeyword: pick(b, "smsConsentKeyword"),
          smsConsentLastKeywordAt: pick(b, "smsConsentLastKeywordAt"),
          smsConsentUpdatedAt: pick(b, "smsConsentUpdatedAt"),
          notes: pick(b, "notes"),
          createdAt,
          updatedAt: createdAt
        };
        await client.upsertEntity(entity, "Merge");
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id: rowKey } };
        return;
      } else {
        const patch = { partitionKey: PARTITION, rowKey: id };
        if (name) patch.name = name;
        setIfPresent(patch, b, "business");
        setIfPresent(patch, b, "accountManager");
        setIfPresent(patch, b, "creator");
        setIfPresent(patch, b, "position");
        setIfPresent(patch, b, "title");
        setIfPresent(patch, b, "firstName");
        setIfPresent(patch, b, "lastName");
        if (phone || Object.prototype.hasOwnProperty.call(b, "phone")) patch.phone = phone;
        setIfPresent(patch, b, "mobile");
        if (email || Object.prototype.hasOwnProperty.call(b, "email")) patch.email = email;
        if (secondaryEmail || Object.prototype.hasOwnProperty.call(b, "secondaryEmail")) {
          patch.secondaryEmail = secondaryEmail;
        }
        setIfPresent(patch, b, "address");
        setIfPresent(patch, b, "address1");
        setIfPresent(patch, b, "address2");
        setIfPresent(patch, b, "address3");
        setIfPresent(patch, b, "town");
        setIfPresent(patch, b, "county");
        setIfPresent(patch, b, "state");
        setIfPresent(patch, b, "postcode");
        setIfPresent(patch, b, "country");
        setIfPresent(patch, b, "accountReference");
        setIfPresent(patch, b, "priceList");
        setIfPresent(patch, b, "paymentTerm");
        setIfPresent(patch, b, "lastQuoteActivity");
        setIfPresent(patch, b, "lastJobActivity");
        setIfPresent(patch, b, "lastInvoiceActivity");
        setIfPresent(patch, b, "lastOpportunityActivity");
        setIfPresent(patch, b, "lastTaskActivity");
        setIfPresent(patch, b, "dateLeft");
        setIfPresent(patch, b, "tags");
        setIfPresent(patch, b, "contactTags");
        setIfPresent(patch, b, "vin");
        setIfPresent(patch, b, "vehicleMake");
        setIfPresent(patch, b, "vehicleModel");
        setIfPresent(patch, b, "vehicleYear");
        setIfPresent(patch, b, "vehicleTrim");
        setIfPresent(patch, b, "vehicleDoors");
        setIfPresent(patch, b, "bedLength");
        setIfPresent(patch, b, "cabType");
        setIfPresent(patch, b, "engineModel");
        setIfPresent(patch, b, "engineCylinders");
        setIfPresent(patch, b, "transmissionStyle");
        setIfPresent(patch, b, "boltPattern");
        setIfPresent(patch, b, "rearBoltPattern");
        setIfPresent(patch, b, "pcd");
        setIfPresent(patch, b, "rearPcd");
        setIfPresent(patch, b, "centreBore");
        setIfPresent(patch, b, "wheelFasteners");
        setIfPresent(patch, b, "wheelTorque");
        setIfPresent(patch, b, "frontTireSize");
        setIfPresent(patch, b, "rearTireSize");
        setIfPresent(patch, b, "frontRimSize");
        setIfPresent(patch, b, "rearRimSize");
        setIfPresent(patch, b, "vehicleColor");
        setIfPresent(patch, b, "smsConsentStatus");
        setIfPresent(patch, b, "smsConsentProvidedAt");
        setIfPresent(patch, b, "smsConsentConfirmedAt");
        setIfPresent(patch, b, "smsConsentRevokedAt");
        setIfPresent(patch, b, "smsConsentPromptSentAt");
        setIfPresent(patch, b, "smsConsentPromptMessageId");
        setIfPresent(patch, b, "smsConsentPromptError");
        setIfPresent(patch, b, "smsConsentExpectedKeyword");
        setIfPresent(patch, b, "smsConsentMethod");
        setIfPresent(patch, b, "smsConsentSource");
        setIfPresent(patch, b, "smsConsentVersion");
        setIfPresent(patch, b, "smsConsentText");
        setIfPresent(patch, b, "smsConsentPageUrl");
        setIfPresent(patch, b, "smsConsentIp");
        setIfPresent(patch, b, "smsConsentKeyword");
        setIfPresent(patch, b, "smsConsentLastKeywordAt");
        setIfPresent(patch, b, "smsConsentUpdatedAt");
        setIfPresent(patch, b, "notes");
        setIfPresent(patch, b, "createdAt");
        patch.updatedAt = new Date().toISOString();

        await client.upsertEntity(patch, "Merge");
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, id } };
        return;
      }
    }

    context.res = { status: 405, headers: { "content-type": "application/json" }, body: { error: "Method not allowed" } };
  } catch (err) {
    context.log.error(err);
    context.res = { status: 500, headers: { "content-type": "application/json" }, body: { error: "Server error", detail: String((err && err.message) || err) } };
  }
};
