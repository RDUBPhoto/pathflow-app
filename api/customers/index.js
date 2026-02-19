// api/customers/index.js
const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

const TABLE = "customers";
const PARTITION = "main";
const CUSTOMER_FIELDS = [
  "name",
  "firstName",
  "lastName",
  "phone",
  "email",
  "address",
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

function fullName(firstName, lastName, name) {
  const explicit = toStr(name).trim();
  if (explicit) return explicit;
  return `${toStr(firstName).trim()} ${toStr(lastName).trim()}`.trim();
}

function toCustomerDto(entity) {
  return {
    id: toStr(entity.rowKey),
    name: toStr(entity.name),
    firstName: toStr(entity.firstName),
    lastName: toStr(entity.lastName),
    phone: toStr(entity.phone),
    email: toStr(entity.email),
    address: toStr(entity.address),
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

function probeFromBody(body) {
  const name = normalizeName(fullName(pick(body, "firstName"), pick(body, "lastName"), pick(body, "name")));
  const email = normalizeEmail(pick(body, "email"));
  const phone = normalizePhone(pick(body, "phone"));
  return { name, email, phone };
}

function buildDuplicateCandidates(customers, probe, excludeId) {
  const excluded = toStr(excludeId).trim();
  const out = [];
  for (const customer of customers) {
    const candidateId = toStr(customer.id);
    if (!candidateId || candidateId === excluded) continue;
    const reasons = [];
    let score = 0;

    if (probe.email && normalizeEmail(customer.email) === probe.email) {
      reasons.push("email");
      score += 100;
    }
    if (probe.phone && normalizePhone(customer.phone) === probe.phone) {
      reasons.push("phone");
      score += 80;
    }
    const candidateName = normalizeName(fullName(customer.firstName, customer.lastName, customer.name));
    if (probe.name && candidateName && candidateName === probe.name) {
      reasons.push("name");
      score += 50;
    }
    if (!reasons.length) continue;

    out.push({
      id: candidateId,
      name: fullName(customer.firstName, customer.lastName, customer.name),
      firstName: toStr(customer.firstName),
      lastName: toStr(customer.lastName),
      email: toStr(customer.email),
      phone: toStr(customer.phone),
      score,
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
      const b = req.body || {};
      const op = String(b.op || "").toLowerCase();
      const id = toStr(b.id);

      if (op === "delete" && id) {
        await client.deleteEntity(PARTITION, id);
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true } };
        return;
      }

      if (op === "findduplicates" || op === "duplicatecheck" || op === "checkduplicates") {
        const probe = probeFromBody(b);
        if (!probe.email && !probe.phone && !probe.name) {
          context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, items: [] } };
          return;
        }
        const customers = await listCustomers(client);
        const excludeId = toStr(b.excludeId || b.id);
        const items = buildDuplicateCandidates(customers, probe, excludeId);
        context.res = { status: 200, headers: { "content-type": "application/json" }, body: { ok: true, items } };
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

      const name = pick(b, "name");
      const phone = pick(b, "phone");
      const email = pick(b, "email");

      if (!id && !name) {
        context.res = { status: 400, headers: { "content-type": "application/json" }, body: { error: "name required" } };
        return;
      }

      if (!id) {
        const rowKey = randomUUID();
        const createdAt = toStr(b.createdAt) || new Date().toISOString();
        const entity = {
          partitionKey: PARTITION,
          rowKey,
          name,
          firstName: pick(b, "firstName"),
          lastName: pick(b, "lastName"),
          phone,
          email,
          address: pick(b, "address"),
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
        setIfPresent(patch, b, "firstName");
        setIfPresent(patch, b, "lastName");
        if (phone || Object.prototype.hasOwnProperty.call(b, "phone")) patch.phone = phone;
        if (email || Object.prototype.hasOwnProperty.call(b, "email")) patch.email = email;
        setIfPresent(patch, b, "address");
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
