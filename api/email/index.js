const { TableClient } = require("@azure/data-tables");
const { randomUUID } = require("crypto");

const EMAIL_TABLE = "emailmessages";
const EMAIL_TEMPLATE_TABLE = "emailtemplates";
const CUSTOMERS_TABLE = "customers";
const LANES_TABLE = "lanes";
const WORKITEMS_TABLE = "workitems";
const PARTITION = "main";
const SIGNATURE_ROW = "__signature__";

function asString(value) {
  return value == null ? "" : String(value).trim();
}

function asBool(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function asObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch (_) {}
  }
  return {};
}

function readHeader(req, key) {
  const headers = req && req.headers ? req.headers : {};
  const target = asString(key).toLowerCase();
  if (!target) return "";

  if (typeof headers.get === "function") {
    return asString(headers.get(target) || headers.get(key));
  }

  const entries = Object.entries(headers || {});
  for (const [name, value] of entries) {
    if (asString(name).toLowerCase() !== target) continue;
    if (Array.isArray(value)) return asString(value[0]);
    return asString(value);
  }
  return "";
}

function parseUrlEncodedBody(rawBody) {
  const out = {};
  const params = new URLSearchParams(asString(rawBody));
  for (const [key, value] of params.entries()) {
    out[key] = value;
  }
  return out;
}

function parseMultipartBody(rawBody, contentType) {
  const match = asString(contentType).match(/boundary="?([^";]+)"?/i);
  if (!match) return {};
  const boundary = `--${match[1]}`;
  const source = String(rawBody || "");
  const sections = source.split(boundary);
  const out = {};

  for (const sectionRaw of sections) {
    let section = sectionRaw.replace(/^\r?\n/, "");
    if (!section || section === "--" || section === "--\r\n") continue;
    section = section.replace(/\r?\n--$/, "").trimEnd();
    if (!section) continue;

    const headerBreak = section.indexOf("\r\n\r\n");
    const altHeaderBreak = section.indexOf("\n\n");
    const splitIndex = headerBreak >= 0 ? headerBreak : altHeaderBreak;
    if (splitIndex < 0) continue;

    const headerText = section.slice(0, splitIndex);
    const valueOffset = headerBreak >= 0 ? 4 : 2;
    const rawValue = section.slice(splitIndex + valueOffset).replace(/\r?\n$/, "");
    const headers = headerText.split(/\r?\n/);
    const dispositionLine = headers.find(line => /^content-disposition:/i.test(line));
    if (!dispositionLine) continue;

    const nameMatch = dispositionLine.match(/name="([^"]+)"/i);
    if (!nameMatch || !nameMatch[1]) continue;
    if (/filename="[^"]*"/i.test(dispositionLine)) continue;
    out[nameMatch[1]] = rawValue;
  }

  return out;
}

function parseRequestBody(req) {
  const body = req && req.body;
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    return body;
  }

  const rawValue = req && req.rawBody != null ? req.rawBody : body;
  const rawBody = Buffer.isBuffer(rawValue) ? rawValue.toString("utf8") : String(rawValue || "");
  if (!rawBody) return {};

  const contentType = readHeader(req, "content-type").toLowerCase();
  if (contentType.includes("application/json")) {
    return asObject(rawBody);
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    return parseUrlEncodedBody(rawBody);
  }
  if (contentType.includes("multipart/form-data")) {
    const parsedMultipart = parseMultipartBody(rawBody, contentType);
    if (Object.keys(parsedMultipart).length) return parsedMultipart;
  }

  const parsedJson = asObject(rawBody);
  if (Object.keys(parsedJson).length) return parsedJson;
  return {};
}

function json(status, body) {
  return {
    status,
    headers: { "content-type": "application/json" },
    body
  };
}

function readQueryParam(req, key) {
  if (req.query && req.query[key] != null) return asString(req.query[key]);
  const rawUrl = asString(req.url);
  if (!rawUrl || rawUrl.indexOf("?") < 0) return "";
  try {
    const parsed = new URL(rawUrl, "http://localhost");
    return asString(parsed.searchParams.get(key));
  } catch {
    return "";
  }
}

function normalizeEmail(value) {
  const raw = asString(value);
  if (!raw) return "";
  const inBrackets = raw.match(/<([^>]+)>/);
  const candidate = asString(inBrackets && inBrackets[1] ? inBrackets[1] : raw);
  const at = candidate.indexOf("@");
  if (at < 1) return "";
  return candidate.toLowerCase();
}

function isEmailAddress(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(asString(value));
}

function splitDisplayName(rawName, fallbackEmail) {
  const clean = asString(rawName)
    .replace(/^"+|"+$/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let candidate = clean;
  if (!candidate) {
    const local = asString(fallbackEmail).split("@")[0] || "";
    candidate = local
      .replace(/[._-]+/g, " ")
      .replace(/\d+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (!candidate) {
    return { firstName: "New", lastName: "Lead", fullName: "New Lead" };
  }

  const parts = candidate
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .map(part => {
      const lower = part.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    });

  const firstName = parts[0] || "New";
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "Lead";
  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim()
  };
}

function getEmailMode() {
  const mode = asString(process.env.EMAIL_MODE).toLowerCase();
  if (mode === "sendgrid") return "sendgrid";
  return "mock";
}

function getConfigStatus() {
  const mode = getEmailMode();
  const hasApiKey = !!asString(process.env.SENDGRID_API_KEY);
  const fromEmail = asString(process.env.EMAIL_FROM || process.env.FROM_EMAIL);
  const hasFromEmail = !!fromEmail;
  const readyForLive = mode === "sendgrid" && hasApiKey && hasFromEmail;
  return {
    mode,
    provider: mode === "sendgrid" ? "sendgrid" : "mock",
    configured: {
      apiKey: hasApiKey,
      fromEmail: hasFromEmail
    },
    fromEmail: fromEmail || null,
    readyForLive
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

function toEmailMessage(entity) {
  return {
    id: asString(entity.rowKey),
    customerId: asString(entity.customerId) || null,
    customerName: asString(entity.customerName) || null,
    direction: asString(entity.direction) === "inbound" ? "inbound" : "outbound",
    from: asString(entity.fromEmail) || null,
    to: asString(entity.toEmail) || null,
    subject: asString(entity.subject),
    message: asString(entity.message),
    html: asString(entity.html) || null,
    createdAt: asString(entity.createdAt) || new Date().toISOString(),
    read: asBool(entity.read),
    readAt: asString(entity.readAt) || null,
    simulated: asBool(entity.simulated),
    provider: asString(entity.provider) || null,
    providerMessageId: asString(entity.providerMessageId) || null
  };
}

function toThreadSummaries(messages) {
  const map = new Map();
  for (const item of messages) {
    const key = asString(item.customerId) || asString(item.from) || asString(item.to) || asString(item.id);
    if (!key) continue;

    const ts = Date.parse(asString(item.createdAt));
    const unread = item.direction === "inbound" && !item.read ? 1 : 0;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        key,
        customerId: item.customerId || null,
        customerName: item.customerName || null,
        customerEmail: item.direction === "inbound" ? (item.from || null) : (item.to || null),
        latestSubject: item.subject || "",
        latestMessage: item.message || "",
        latestAt: item.createdAt || new Date().toISOString(),
        latestDirection: item.direction,
        unread,
        _latestTs: Number.isFinite(ts) ? ts : 0
      });
      continue;
    }

    existing.unread += unread;
    if (Number.isFinite(ts) && ts >= existing._latestTs) {
      existing._latestTs = ts;
      existing.latestSubject = item.subject || "";
      existing.latestMessage = item.message || "";
      existing.latestAt = item.createdAt || existing.latestAt;
      existing.latestDirection = item.direction;
      existing.customerEmail = item.direction === "inbound" ? (item.from || null) : (item.to || null);
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
      customerEmail: item.customerEmail,
      latestSubject: item.latestSubject,
      latestMessage: item.latestMessage,
      latestAt: item.latestAt,
      latestDirection: item.latestDirection,
      unread: item.unread
    }));
}

function escapedFilterValue(value) {
  return asString(value).replace(/'/g, "''");
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

async function listAllMessages(client) {
  const out = [];
  const iter = client.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
  for await (const entity of iter) {
    out.push(toEmailMessage(entity));
  }
  return out;
}

async function saveEmailMessage(client, payload) {
  const now = new Date().toISOString();
  const id = randomUUID();
  await client.upsertEntity(
    {
      partitionKey: PARTITION,
      rowKey: id,
      customerId: asString(payload.customerId),
      customerName: asString(payload.customerName),
      direction: asString(payload.direction) === "inbound" ? "inbound" : "outbound",
      fromEmail: asString(payload.from),
      toEmail: asString(payload.to),
      subject: asString(payload.subject),
      message: asString(payload.message),
      html: asString(payload.html),
      createdAt: now,
      read: asBool(payload.read),
      readAt: asString(payload.readAt),
      simulated: asBool(payload.simulated),
      provider: asString(payload.provider),
      providerMessageId: asString(payload.providerMessageId)
    },
    "Merge"
  );
  return { id, createdAt: now };
}

async function markRead(client, id) {
  const itemId = asString(id);
  if (!itemId) return false;
  try {
    await client.getEntity(PARTITION, itemId);
  } catch {
    return false;
  }

  await client.upsertEntity(
    {
      partitionKey: PARTITION,
      rowKey: itemId,
      read: true,
      readAt: new Date().toISOString()
    },
    "Merge"
  );
  return true;
}

async function listTemplates(templateClient) {
  const templates = [];
  let signature = "";
  const iter = templateClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
  for await (const entity of iter) {
    const rowKey = asString(entity.rowKey);
    if (!rowKey) continue;
    if (rowKey === SIGNATURE_ROW) {
      signature = asString(entity.body);
      continue;
    }

    templates.push({
      id: rowKey,
      name: asString(entity.name),
      subject: asString(entity.subject),
      body: asString(entity.body),
      updatedAt: asString(entity.updatedAt) || asString(entity.timestamp)
    });
  }

  templates.sort((a, b) => {
    const ta = Date.parse(asString(a.updatedAt));
    const tb = Date.parse(asString(b.updatedAt));
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    if (Number.isFinite(tb)) return 1;
    if (Number.isFinite(ta)) return -1;
    return a.name.localeCompare(b.name);
  });
  return { templates, signature };
}

async function upsertTemplate(templateClient, payload) {
  const id = asString(payload.id) || randomUUID();
  const name = asString(payload.name);
  const subject = asString(payload.subject);
  const body = asString(payload.body);
  if (!name || !subject || !body) {
    throw new Error("Template name, subject, and body are required.");
  }

  await templateClient.upsertEntity(
    {
      partitionKey: PARTITION,
      rowKey: id,
      name,
      subject,
      body,
      updatedAt: new Date().toISOString()
    },
    "Merge"
  );
  return id;
}

async function deleteTemplate(templateClient, id) {
  const templateId = asString(id);
  if (!templateId || templateId === SIGNATURE_ROW) return false;
  try {
    await templateClient.deleteEntity(PARTITION, templateId);
    return true;
  } catch {
    return false;
  }
}

async function setDefaultSignature(templateClient, signature) {
  await templateClient.upsertEntity(
    {
      partitionKey: PARTITION,
      rowKey: SIGNATURE_ROW,
      body: asString(signature),
      updatedAt: new Date().toISOString()
    },
    "Merge"
  );
}

async function findCustomerByEmail(customersClient, email) {
  const target = normalizeEmail(email);
  if (!target) return null;
  const iter = customersClient.listEntities({ queryOptions: { filter: `PartitionKey eq '${PARTITION}'` } });
  for await (const entity of iter) {
    const itemEmail = normalizeEmail(entity.email);
    if (!itemEmail || itemEmail !== target) continue;
    return {
      id: asString(entity.rowKey),
      name: asString(entity.name),
      firstName: asString(entity.firstName),
      lastName: asString(entity.lastName),
      email: itemEmail
    };
  }
  return null;
}

async function createCustomerFromInbound(customersClient, senderEmail, senderName) {
  const email = normalizeEmail(senderEmail);
  if (!email) return null;
  const now = new Date().toISOString();
  const id = randomUUID();
  const parsed = splitDisplayName(senderName, email);

  await customersClient.upsertEntity(
    {
      partitionKey: PARTITION,
      rowKey: id,
      name: parsed.fullName,
      firstName: parsed.firstName,
      lastName: parsed.lastName,
      email,
      phone: "",
      address: "",
      createdAt: now,
      updatedAt: now
    },
    "Merge"
  );

  return {
    id,
    name: parsed.fullName,
    firstName: parsed.firstName,
    lastName: parsed.lastName,
    email
  };
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
      existing = {
        id: asString(entity.rowKey),
        name: name || "Leads"
      };
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

async function createLeadWorkItem(workItemsClient, laneId, customer, subject) {
  const safeLane = escapedFilterValue(laneId);
  const iter = workItemsClient.listEntities({
    queryOptions: { filter: `PartitionKey eq '${PARTITION}' and laneId eq '${safeLane}'` }
  });
  let maxSort = 0;
  for await (const entity of iter) {
    const sort = Number(entity.sort);
    if (Number.isFinite(sort)) maxSort = Math.max(maxSort, sort);
  }

  const now = new Date().toISOString();
  const titleBase = asString(customer && customer.name) || asString(customer && customer.email) || "New Lead";
  const titleSubject = asString(subject) || "Email inquiry";
  const title = `${titleBase} — ${titleSubject}`.slice(0, 240);

  const id = randomUUID();
  await workItemsClient.upsertEntity(
    {
      partitionKey: PARTITION,
      rowKey: id,
      title,
      laneId: asString(laneId),
      customerId: asString(customer && customer.id),
      sort: maxSort + 10,
      createdAt: now,
      updatedAt: now
    },
    "Merge"
  );
  return id;
}

async function sendViaSendgrid(to, subject, message) {
  const key = asString(process.env.SENDGRID_API_KEY);
  const from = asString(process.env.EMAIL_FROM || process.env.FROM_EMAIL);
  if (!key || !from) {
    throw new Error("EMAIL_MODE is sendgrid but SENDGRID_API_KEY or EMAIL_FROM is missing.");
  }

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: from },
      subject,
      content: [{ type: "text/plain", value: message }]
    })
  });

  if (!response.ok) {
    const detail = asString(await response.text());
    throw new Error(`SendGrid rejected message (${response.status}): ${detail || "Unknown provider error."}`);
  }

  return {
    provider: "sendgrid",
    providerMessageId: asString(response.headers.get("x-message-id"))
  };
}

module.exports = async function (context, req) {
  const method = asString(req.method || "GET").toUpperCase();
  const body = parseRequestBody(req);
  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }

  try {
    if (method === "GET") {
      const scope = readQueryParam(req, "scope").toLowerCase();
      if (!scope) {
        context.res = json(200, {
          ok: true,
          ...getConfigStatus()
        });
        return;
      }

      if (scope === "templates") {
        const templateClient = await getTableClient(EMAIL_TEMPLATE_TABLE);
        const data = await listTemplates(templateClient);
        context.res = json(200, {
          ok: true,
          scope,
          templates: data.templates,
          signature: data.signature
        });
        return;
      }

      const messageClient = await getTableClient(EMAIL_TABLE);
      const all = await listAllMessages(messageClient);

      if (scope === "inbox") {
        const items = all
          .filter(item => item.direction === "inbound" && !item.read)
          .sort(sortByCreatedDesc);
        context.res = json(200, { ok: true, scope, items });
        return;
      }

      if (scope === "customer") {
        const customerId = readQueryParam(req, "customerId");
        if (!customerId) {
          context.res = json(400, { error: "customerId is required for scope=customer." });
          return;
        }
        const items = all
          .filter(item => item.customerId === customerId)
          .sort(sortByCreatedAsc);
        context.res = json(200, { ok: true, scope, customerId, items });
        return;
      }

      if (scope === "threads") {
        const rawLimit = Number(readQueryParam(req, "limit"));
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 0;
        let items = toThreadSummaries(all);
        if (limit > 0) items = items.slice(0, limit);
        context.res = json(200, { ok: true, scope, items });
        return;
      }

      context.res = json(400, { error: "Unknown scope. Use `inbox`, `customer`, `threads`, or `templates`." });
      return;
    }

    if (method !== "POST") {
      context.res = json(405, { error: "Method not allowed" });
      return;
    }

    const op = asString(body.op || body.operation || body.action).toLowerCase();

    if (op === "markread" || op === "mark-read") {
      const id = asString(body.id);
      if (!id) {
        context.res = json(400, { error: "id is required for markRead." });
        return;
      }

      const messageClient = await getTableClient(EMAIL_TABLE);
      const ok = await markRead(messageClient, id);
      if (!ok) {
        context.res = json(404, { error: "Email message not found." });
        return;
      }

      context.res = json(200, { ok: true, id });
      return;
    }

    if (op === "markreadbatch" || op === "mark-read-batch") {
      const ids = Array.isArray(body.ids) ? body.ids.map(asString).filter(Boolean) : [];
      if (!ids.length) {
        context.res = json(400, { error: "ids is required for markReadBatch." });
        return;
      }

      const messageClient = await getTableClient(EMAIL_TABLE);
      let updated = 0;
      for (const id of ids) {
        try {
          const ok = await markRead(messageClient, id);
          if (ok) updated += 1;
        } catch (_) {}
      }

      context.res = json(200, { ok: true, updated });
      return;
    }

    if (op === "upserttemplate" || op === "upsert-template") {
      const templateClient = await getTableClient(EMAIL_TEMPLATE_TABLE);
      const id = await upsertTemplate(templateClient, body);
      const data = await listTemplates(templateClient);
      context.res = json(200, {
        ok: true,
        id,
        templates: data.templates,
        signature: data.signature
      });
      return;
    }

    if (op === "deletetemplate" || op === "delete-template") {
      const id = asString(body.id);
      if (!id) {
        context.res = json(400, { error: "id is required for deleteTemplate." });
        return;
      }

      const templateClient = await getTableClient(EMAIL_TEMPLATE_TABLE);
      const ok = await deleteTemplate(templateClient, id);
      if (!ok) {
        context.res = json(404, { error: "Template not found." });
        return;
      }

      const data = await listTemplates(templateClient);
      context.res = json(200, {
        ok: true,
        templates: data.templates,
        signature: data.signature
      });
      return;
    }

    if (op === "setsignature" || op === "set-signature") {
      const signature = asString(body.signature);
      const templateClient = await getTableClient(EMAIL_TEMPLATE_TABLE);
      await setDefaultSignature(templateClient, signature);
      const data = await listTemplates(templateClient);
      context.res = json(200, {
        ok: true,
        templates: data.templates,
        signature: data.signature
      });
      return;
    }

    const requestedCustomerId = asString(body.customerId);
    const requestedCustomerName = asString(body.customerName);
    const requestSubject = asString(body.subject);
    const requestMessage = asString(body.message || body.text || body.body);
    const requestHtml = asString(body.html);
    const requestFrom = normalizeEmail(body.from || body.sender || body.fromEmail || body.email);
    const requestFromName = asString(body.fromName || body.senderName || body.name || body.from);
    const requestTo = normalizeEmail(body.to || body.toEmail);

    const requestDirection = asString(body.direction).toLowerCase();
    const inboundHint = requestDirection === "inbound" || asBool(body.inbound);
    const inferredInbound = (!op || op === "receive") &&
      !!requestFrom &&
      (!!requestMessage || !!requestSubject || !!requestHtml || inboundHint);

    if (op === "logincoming" || op === "log-incoming" || op === "inbound" || inferredInbound) {
      if (!requestFrom && !requestedCustomerId) {
        context.res = json(400, { error: "from email or customerId is required for inbound email." });
        return;
      }
      if (!requestMessage && !requestHtml) {
        context.res = json(400, { error: "message or html content is required for inbound email." });
        return;
      }

      const customersClient = await getTableClient(CUSTOMERS_TABLE);
      const lanesClient = await getTableClient(LANES_TABLE);
      const workItemsClient = await getTableClient(WORKITEMS_TABLE);

      let resolvedCustomerId = requestedCustomerId;
      let resolvedCustomerName = requestedCustomerName;
      let customerCreated = false;
      let leadCreated = false;

      if (!resolvedCustomerId && requestFrom) {
        const existing = await findCustomerByEmail(customersClient, requestFrom);
        if (existing) {
          resolvedCustomerId = existing.id;
          resolvedCustomerName = existing.name || resolvedCustomerName;
        } else {
          const created = await createCustomerFromInbound(customersClient, requestFrom, requestFromName);
          if (created) {
            resolvedCustomerId = created.id;
            resolvedCustomerName = created.name;
            customerCreated = true;

            const leadsLane = await ensureLeadsLane(lanesClient);
            await createLeadWorkItem(workItemsClient, leadsLane.id, created, requestSubject);
            leadCreated = true;
          }
        }
      }

      const config = getConfigStatus();
      const messageClient = await getTableClient(EMAIL_TABLE);
      const saved = await saveEmailMessage(messageClient, {
        customerId: resolvedCustomerId,
        customerName: resolvedCustomerName,
        direction: "inbound",
        from: requestFrom,
        to: requestTo || config.fromEmail || "",
        subject: requestSubject || "New email inquiry",
        message: requestMessage || "",
        html: requestHtml,
        read: false,
        readAt: "",
        simulated: true,
        provider: "inbound",
        providerMessageId: asString(body.providerMessageId || body.messageId)
      });

      context.res = json(200, {
        ok: true,
        direction: "inbound",
        id: saved.id,
        createdAt: saved.createdAt,
        customerId: resolvedCustomerId || null,
        customerName: resolvedCustomerName || null,
        customerCreated,
        leadCreated
      });
      return;
    }

    if (!requestTo || !requestSubject || !requestMessage) {
      context.res = json(400, { error: "`to`, `subject`, and `message` are required." });
      return;
    }
    if (!isEmailAddress(requestTo)) {
      context.res = json(400, { error: "`to` must be a valid email address." });
      return;
    }

    const config = getConfigStatus();
    let simulated = true;
    let provider = config.provider;
    let providerMessageId = "";

    if (config.mode === "sendgrid") {
      if (!config.readyForLive) {
        context.res = json(500, {
          error: "EMAIL_MODE is sendgrid but SENDGRID_API_KEY or EMAIL_FROM is missing."
        });
        return;
      }
      const sendResult = await sendViaSendgrid(requestTo, requestSubject, requestMessage);
      simulated = false;
      provider = sendResult.provider;
      providerMessageId = sendResult.providerMessageId;
    } else {
      if (typeof context.log === "function") {
        context.log("[email][mock] to=%s subject=%s", requestTo, requestSubject);
      }
    }

    const messageClient = await getTableClient(EMAIL_TABLE);
    const saved = await saveEmailMessage(messageClient, {
      customerId: requestedCustomerId,
      customerName: requestedCustomerName,
      direction: "outbound",
      from: config.fromEmail || "",
      to: requestTo,
      subject: requestSubject,
      message: requestMessage,
      html: requestHtml,
      read: true,
      readAt: new Date().toISOString(),
      simulated,
      provider,
      providerMessageId
    });

    context.res = json(200, {
      ok: true,
      mode: config.mode,
      provider,
      simulated,
      id: saved.id,
      createdAt: saved.createdAt,
      to: requestTo,
      customerId: requestedCustomerId || null,
      messageId: providerMessageId || null
    });
  } catch (err) {
    if (context.log && typeof context.log.error === "function") context.log.error(err);
    context.res = json(500, {
      error: "Server error",
      detail: String((err && err.message) || err)
    });
  }
};
