const { sanitizeAmount, invoicePublishedTotal, invoicePreviouslyPaid, invoiceBalance } = require("../_shared/invoice-balances");
const { isPortalToken, portalTokenFromHeader, allowsPortalAction, rememberPortalClosure } = require("../_shared/customer-portal");
const { resolveStaff, isActiveTenantUser } = require("../_shared/staff-access");
const { scopedTenantPartition } = require("../_shared/notification-partition");
const { TableClient, isSqlBackendEnabled } = require("../_shared/table-client");
const { resolveTenantId } = require("../_shared/tenant");
const { createHash } = require("crypto");
const { gatewayConfig, invoiceCheckoutProvider } = require("../_shared/paylynx");
const { acquireInvoicePaymentLock } = require("../_shared/invoice-payment-lock");

const TABLE = "invoiceresponses";
const NOTIFICATIONS_TABLE = "notifications";
const INVENTORY_NEEDS_TABLE = "inventoryneeds";
const JOB_TASKS_TABLE = "jobtasks";
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

function normalizeAction(value) {
  const action = asString(value).toLowerCase();
  if (action === "pay" || action === "paid") return "pay";
  return "";
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

async function upsertNotificationPreservingRead(notificationClient, entity) {
  const partitionKey = asString(entity && entity.partitionKey);
  const rowKey = asString(entity && entity.rowKey);
  if (!partitionKey || !rowKey) return false;

  let existing = null;
  try {
    existing = await notificationClient.getEntity(partitionKey, rowKey);
  } catch (_) {
    existing = null;
  }

  const alreadyRead = existing ? asBool(existing.read) : false;
  await notificationClient.upsertEntity(
    {
      ...entity,
      read: alreadyRead ? true : false,
      readAt: alreadyRead ? asString(existing && existing.readAt) : "",
      createdAt: asString(existing && existing.createdAt) || asString(entity.createdAt),
      updatedAt: asString(entity.updatedAt) || new Date().toISOString()
    },
    "Merge"
  );
  return !existing;
}

function asNumber(value, fallback = 0) {
  const parsed = Number(asString(value).replace(/[$,%\s]/g, "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function rowKeyForInventoryNeed(invoiceId, line) {
  const lineId = asString(line && line.id);
  const partName = asString(line && (line.description || line.code || line.partName));
  const hash = createHash("sha1")
    .update([invoiceId, lineId, partName].join("|"))
    .digest("hex")
    .slice(0, 20);
  return `invoice-part-${hash}`;
}

function isPartLineNeedingOrder(line) {
  const lineType = asString(line && line.type).toLowerCase();
  const status = asString(line && line.partStatus).toLowerCase();
  if (lineType === "labor") return false;
  if (status === "ordered" || status === "received" || status === "in-stock" || status === "in stock") return false;
  const partName = asString(line && (line.description || line.code || line.partName));
  if (!partName) return false;
  return asNumber(line && line.quantity, 1) > 0;
}

async function upsertInventoryNeedsForPaidInvoice(needsClient, tenantId, payload) {
  const invoiceId = asString(payload && payload.invoiceId);
  if (!invoiceId) return 0;

  const lineItems = Array.isArray(payload && payload.lineItems) ? payload.lineItems : [];
  const partLines = lineItems.filter(isPartLineNeedingOrder);
  if (!partLines.length) return 0;

  const now = new Date().toISOString();
  const jobNumber = asString(payload.jobNumber);
  const jobId = jobNumber ? `job-number:${jobNumber}` : `document:${invoiceId}`;
  let count = 0;

  for (const line of partLines) {
    const rowKey = rowKeyForInventoryNeed(invoiceId, line);
    let existing = null;
    try {
      existing = await needsClient.getEntity(tenantId, rowKey);
    } catch (_) {}

    const existingStatus = asString(existing && existing.status).toLowerCase();
    const existingJobPartStatus = asString(existing && existing.jobPartStatus).toLowerCase();
    const qtyNeeded = Math.max(1, Math.ceil(asNumber(line && line.quantity, 1)));
    const unitPrice = Math.max(0, asNumber(line && line.unitPrice, 0));

    await needsClient.upsertEntity(
      {
        partitionKey: tenantId,
        rowKey,
        jobId: asString(existing && existing.jobId) || jobId,
        jobNumber: asString(existing && existing.jobNumber) || jobNumber,
        relatedScheduleId: asString(existing && existing.relatedScheduleId),
        relatedWorkItemId: asString(existing?.relatedWorkItemId || payload.relatedWorkItemId),
        relatedQuoteId: asString(existing && existing.relatedQuoteId),
        relatedInvoiceId: invoiceId,
        relatedInvoiceLineItemId: asString(line && line.id),
        relatedInventoryItemId: asString(line && line.relatedInventoryItemId),
        sourceType: "invoice",
        sourceId: invoiceId,
        scheduleStart: asString(existing && existing.scheduleStart),
        scheduleEnd: asString(existing && existing.scheduleEnd),
        resource: asString(existing && existing.resource),
        customerId: asString(payload.customerId || (existing && existing.customerId)),
        customerName: asString(payload.customerName || (existing && existing.customerName)),
        vehicle: asString(payload.vehicle || (existing && existing.vehicle)),
        partName: asString(line && (line.description || line.code || line.partName)) || "Part",
        description: asString(line && line.description),
        sku: asString(line && line.code),
        qty: qtyNeeded,
        qtyNeeded,
        qtyOrdered: Math.max(0, asNumber(existing && existing.qtyOrdered, 0)),
        qtyReceived: Math.max(0, asNumber(existing && existing.qtyReceived, 0)),
        qtyPulled: Math.max(0, asNumber(existing && existing.qtyPulled, 0)),
        qtyInstalled: Math.max(0, asNumber(existing && existing.qtyInstalled, 0)),
        cost: Math.max(0, asNumber(existing && existing.cost, 0)),
        markup: Math.max(0, asNumber(existing && existing.markup, 0)),
        customerPrice: unitPrice,
        vendorId: asString(existing && existing.vendorId),
        vendorHint: asString(existing && existing.vendorHint),
        note: asString(existing && existing.note) || `Created when invoice ${asString(payload.invoiceNumber) || invoiceId} was paid.`,
        status: existingStatus && existingStatus !== "needs-order" ? existingStatus : "needs-order",
        jobPartStatus: existingJobPartStatus && existingJobPartStatus !== "quoted" ? existingJobPartStatus : "quoted",
        purchaseOrderId: asString(existing && existing.purchaseOrderId),
        createdAt: asString(existing && existing.createdAt) || now,
        updatedAt: now
      },
      "Merge"
    );
    count += 1;
  }

  return count;
}

function rowKeyForPaidInvoicePartsOrderTask(tenantId, invoiceId) {
  return createHash("sha1")
    .update([tenantId, invoiceId, "parts-order"].join("|"))
    .digest("hex");
}

function normalizeTaskStatus(value) {
  const normalized = asString(value).toLowerCase();
  if (normalized === "in_progress" || normalized === "in-progress") return "in_progress";
  if (normalized === "completed") return "completed";
  if (normalized === "cancelled" || normalized === "canceled") return "cancelled";
  return "open";
}

async function upsertPartsOrderTaskForPaidInvoice(taskClient, tenantId, payload) {
  const invoiceId = asString(payload && payload.invoiceId);
  if (!invoiceId) return 0;

  const lineItems = Array.isArray(payload && payload.lineItems) ? payload.lineItems : [];
  const partLines = lineItems.filter(isPartLineNeedingOrder);
  if (!partLines.length) return 0;

  const now = new Date().toISOString();
  const rowKey = rowKeyForPaidInvoicePartsOrderTask(tenantId, invoiceId);
  let existing = null;
  try {
    existing = await taskClient.getEntity(tenantId, rowKey);
  } catch (_) {}

  const invoiceNumber = asString(payload.invoiceNumber) || invoiceId;
  const jobNumber = asString(payload.jobNumber);
  const jobId = jobNumber ? `job-number:${jobNumber}` : `document:${invoiceId}`;
  const partNames = partLines
    .map(line => asString(line && (line.description || line.code || line.partName)))
    .filter(Boolean)
    .slice(0, 4);
  const extraCount = Math.max(0, partLines.length - partNames.length);
  const warningParts = partNames.join(", ") + (extraCount ? `, +${extraCount} more` : "");

  await taskClient.upsertEntity(
    {
      partitionKey: tenantId,
      rowKey,
      taskType: "parts-order",
      jobId: asString(existing && existing.jobId) || jobId,
      jobNumber: asString(existing && existing.jobNumber) || jobNumber,
      relatedInvoiceId: invoiceId,
      customerName: asString(payload.customerName || (existing && existing.customerName)),
      vehicle: asString(payload.vehicle || (existing && existing.vehicle)),
      title: `Order parts for paid invoice ${invoiceNumber}`,
      description: `${partLines.length} product/part line item(s) need ordering after invoice payment.`,
      assignedRole: asString(existing && existing.assignedRole) || "Inventory / Front Desk",
      ownerRole: asString(existing && existing.ownerRole) || "Inventory Manager",
      ownerUser: asString(existing && existing.ownerUser),
      dueDate: asString(existing && existing.dueDate) || now,
      priority: asString(existing && existing.priority) || "high",
      status: normalizeTaskStatus(existing && existing.status),
      comments: asString(existing && existing.comments),
      warning: asString(existing && existing.warning) || (warningParts ? `Needs order: ${warningParts}.` : "Parts need ordering."),
      completedAt: asString(existing && existing.completedAt),
      completedBy: asString(existing && existing.completedBy),
      completedById: asString(existing && existing.completedById),
      createdAt: asString(existing && existing.createdAt) || now,
      updatedAt: now
    },
    "Merge"
  );
  return existing ? 0 : 1;
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

async function getEntityIfExists(client, tenantId, id) {
  try { return await client.getEntity(tenantId, id); }
  catch (error) { if (error.statusCode !== 404) throw error; return null; }
}

function paymentAttemptKey(invoiceId, invoice) {
  const total = invoicePublishedTotal(invoice);
  const publishedPaidCents = Math.max(0, Math.round((total - sanitizeAmount(invoice?.amount)) * 100));
  const generation = invoice?.paymentRevision ? `|${invoice.paymentRevision}` : "";
  return createHash("sha256").update(`${invoiceId}|${publishedPaidCents}${generation}`).digest("hex");
}

function customerInvoiceData(data) {
  return {
    subtotal: sanitizeAmount(data.subtotal),
    taxTotal: sanitizeAmount(data.taxTotal),
    total: sanitizeAmount(data.total),
    lineItems: Array.isArray(data.lineItems) ? data.lineItems.map(line => ({
      type: line?.type === "labor" ? "labor" : "part",
      code: asString(line?.code),
      description: asString(line?.description),
      quantity: sanitizeAmount(line?.quantity),
      unitPrice: sanitizeAmount(line?.unitPrice),
      lineSubtotal: sanitizeAmount(line?.lineSubtotal),
      lineTotal: sanitizeAmount(line?.lineTotal)
    })) : []
  };
}

async function recordInvoicePayment(tenantId, payload) {
  const { invoiceId } = payload;
  const client = await getTableClient(TABLE);
  const existing = await getEntityIfExists(client, tenantId, invoiceId);
  const now = new Date().toISOString();
  const samePayment = existing?.stage === "accepted" &&
    existing.paymentProvider === payload.paymentProvider &&
    existing.paymentTransactionId === asString(payload.paymentTransactionId) &&
    existing.paidAmount === payload.paidAmount;
  let paidAt = samePayment ? asString(existing.paidAt) || now : now;
  const jobId = asString(existing?.jobId) || `document:${invoiceId}`;
  const ledger = await getTableClient("paymentledger");
  const ledgerKey = createHash("sha256").update(
    `${invoiceId}|${payload.paymentProvider}|${payload.paymentTransactionId || payload.paidAmount}`
  ).digest("hex");
  try {
    await ledger.createEntity({ partitionKey: tenantId, rowKey: ledgerKey, invoiceId,
      amount: sanitizeAmount(payload.paymentAmount), paidAt, provider: payload.paymentProvider,
      transactionId: asString(payload.paymentTransactionId), paymentKind: payload.paymentKind,
      mode: ["live", "test"].includes(payload.mode) ? payload.mode : "",
      accountNumber: maskCardLast4(payload.paymentAccountNumber) });
  } catch (error) {
    if (error.statusCode !== 409) throw error;
    paidAt = (await getEntityIfExists(ledger, tenantId, ledgerKey))?.paidAt || paidAt;
  }
  const relatedWorkItemId = await ensurePaidJob(tenantId, jobId, payload, paidAt);
  payload = { ...payload, relatedWorkItemId };
  const [notifications, users, needs, tasks] = await Promise.all([
    getTableClient(NOTIFICATIONS_TABLE),
    getTableClient(USERS_TABLE),
    getTableClient(INVENTORY_NEEDS_TABLE),
    getTableClient(JOB_TASKS_TABLE)
  ]);
  const notificationsCreated = await createInvoicePaidNotifications(notifications, users, tenantId, payload);
  const inventoryNeedsCreated = await upsertInventoryNeedsForPaidInvoice(needs, tenantId, payload);
  const partsOrderTasksCreated = await upsertPartsOrderTaskForPaidInvoice(tasks, tenantId, payload);
  if (!samePayment) {
    await client.upsertEntity({
      partitionKey: tenantId,
      rowKey: invoiceId,
      invoiceId,
      action: "pay",
      stage: "accepted",
      invoiceNumber: asString(payload.invoiceNumber),
      jobId,
      jobNumber: asString(payload.jobNumber),
      customerId: asString(payload.customerId),
      customerName: asString(payload.customerName),
      vehicle: asString(payload.vehicle),
      businessName: asString(payload.businessName),
      paymentAmount: sanitizeAmount(payload.paymentAmount),
      paidAmount: sanitizeAmount(payload.paidAmount),
      paymentKind: payload.paymentKind,
      paymentProvider: asString(payload.paymentProvider),
      paymentTransactionId: asString(payload.paymentTransactionId),
      paymentAccountNumber: maskCardLast4(payload.paymentAccountNumber),
      paymentRecordedBy: asString(payload.actor?.email),
      paidAt,
      updatedAt: paidAt
    }, "Merge");
    await rememberPortalClosure(tenantId, invoiceId).catch(() => {});
  }
  return { ok: true, tenantId, invoiceId, jobId, action: "pay", stage: "accepted", updatedAt: paidAt,
    notificationsCreated, inventoryNeedsCreated, partsOrderTasksCreated };
}

async function ensurePaidJob(tenantId, jobId, payload, paidAt) {
  const [jobs, items, lanes] = await Promise.all([
    getTableClient("servicejobs"), getTableClient("workitems"), getTableClient("lanes")
  ]);
  const filter = `PartitionKey eq '${tenantId}'`;
  const fallbackCardId = `job-${createHash("sha256").update(payload.invoiceId).digest("hex").slice(0, 32)}`;
  let workItem;
  const docTag = `[doc=${payload.invoiceId}]`;
  for await (const item of items.listEntities({ queryOptions: { filter } })) {
    if (item.invoiceId === payload.invoiceId || asString(item.title).includes(docTag)) {
      workItem = item;
      break;
    }
  }
  const existingJob = await getEntityIfExists(jobs, tenantId, jobId);
  const workItemId = workItem?.rowKey || existingJob?.workItemId || fallbackCardId;
  if (!existingJob) {
    try {
      await jobs.createEntity({ partitionKey: tenantId, rowKey: jobId, invoiceId: payload.invoiceId,
        customerId: asString(payload.customerId), jobNumber: asString(payload.jobNumber), workItemId,
        createdAt: paidAt });
    } catch (error) { if (error.statusCode !== 409) throw error; }
  }
  if (workItem) {
    if (workItem.jobId !== jobId) await items.upsertEntity({ partitionKey: tenantId, rowKey: workItemId,
      jobId, invoiceId: payload.invoiceId }, "Merge");
    return workItemId;
  }
  const laneRows = [];
  for await (const lane of lanes.listEntities({ queryOptions: { filter } })) laneRows.push(lane);
  const invoiceLane = laneRows.find(lane => lane.stageKey === "invoiced" || /^invoic(es?|ed)$/i.test(asString(lane.name)));
  if (!invoiceLane) return "";
  try {
    await items.createEntity({ partitionKey: tenantId, rowKey: workItemId, laneId: invoiceLane.rowKey,
      title: `${payload.customerName || "Customer"} — Invoice ${payload.invoiceNumber || payload.invoiceId} ${docTag}`,
      customerId: asString(payload.customerId), jobId, invoiceId: payload.invoiceId, createdAt: paidAt, updatedAt: paidAt });
  } catch (error) { if (error.statusCode !== 409) throw error; }
  return workItemId;
}

async function listTenantRecipients(userClient, tenantId) {
  const out = [];
  const seen = new Set();
  const filter = `PartitionKey eq '${escapedFilterValue(USERS_PARTITION)}'`;
  const iter = userClient.listEntities({ queryOptions: { filter } });
  for await (const entity of iter) {
    if (!isActiveTenantUser(entity, tenantId)) continue;
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

async function createInvoicePaidNotifications(notificationClient, userClient, tenantId, payload) {
  const invoiceId = asString(payload.invoiceId);
  if (!invoiceId) return 0;
  const notificationPartition = scopedTenantPartition(tenantId);
  const paymentKind = asString(payload.paymentKind).toLowerCase() === "final" ? "final" : "initial";
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
    const rowKey = rowKeyForNotification(invoiceId, `${paymentKind}-paid`, recipientKey);
    await upsertNotificationPreservingRead(
      notificationClient,
      {
        tenantId,
        partitionKey: notificationPartition,
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
      }
    );
    count += 1;

    if (partsToOrder.length) {
      const inventoryRowKey = rowKeyForNotification(invoiceId, "inventory-order-needed", recipientKey);
      await upsertNotificationPreservingRead(
        notificationClient,
        {
          tenantId,
          partitionKey: notificationPartition,
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
        }
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

  if (method === "OPTIONS") {
    context.res = { status: 204 };
    return;
  }

  let releasePaymentLock;
  try {
    const client = await getTableClient(TABLE);
    const publicToken = portalTokenFromHeader(req.headers) || asString(readQueryParam(req, "publicToken"));
    const { actor, authorized } = publicToken && method === "GET"
      ? { actor: null, authorized: false }
      : await resolveStaff(req, await getTableClient(USERS_TABLE), tenantId);

    if (method === "GET") {
      if (!authorized && !publicToken) {
        context.res = json(actor ? 403 : 401, { ok: false, error: "Authorized staff session required." });
        return;
      }

      const invoiceId = asString(readQueryParam(req, "invoiceId"));
      if (publicToken && !invoiceId) {
        context.res = json(400, { ok: false, error: "Invoice is required for a public link." });
        return;
      }
      if (invoiceId) {
        try {
          const item = await client.getEntity(tenantId, invoiceId);
          if (publicToken) {
            const portalLink = isPortalToken(publicToken);
            const authorizedLink = portalLink
              ? await allowsPortalAction(tenantId, publicToken, "invoice", invoiceId)
              : asString(item.publicToken) === publicToken;
            if (!authorizedLink) {
              context.res = json(404, { ok: false, error: "Invoice not found." });
              return;
            }
            const balance = invoiceBalance(item);
            const invoiceData = parseJson(item.invoiceDataJson, null);
            const paymentSettings = parseJson((await getEntityIfExists(await getTableClient("appsettings"), tenantId, "billing.paymentProviders"))?.valueJson, {});
            context.res = json(200, {
              ok: true,
              tenantId,
              item: {
                invoiceId,
                ...(portalLink ? {} : { publicToken }),
                invoiceData: portalLink ? customerInvoiceData(invoiceData || {}) : invoiceData,
                invoiceNumber: asString(item.invoiceNumber),
                customerName: asString(item.customerName),
                customerEmail: asString(item.customerEmail),
                vehicle: asString(item.vehicle),
                businessName: asString(item.businessName),
                amount: String(balance),
                paidAmount: Number(item.paidAmount || 0),
                returnCreditAmount: Number(item.returnCreditAmount || 0),
                paidAt: balance === 0 ? asString(item.paidAt) : "",
                dueDate: asString(item.dueDate),
                paymentUrl: asString(item.paymentUrl),
                paymentProvider: invoiceCheckoutProvider(item, paymentSettings, tenantId),
                updatedAt: asString(item.updatedAt)
              }
            });
            return;
          }
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
              paidAmount: Number(item.paidAmount || 0),
              paymentKind: asString(item.paymentKind),
              jobId: asString(item.jobId),
              paymentProvider: asString(item.paymentProvider),
              paymentTransactionId: asString(item.paymentTransactionId),
              paymentAccountNumber: asString(item.paymentAccountNumber)
            }
          });
          return;
        } catch (error) {
          if (error.statusCode !== 404) throw error;
          context.res = publicToken ? json(404, { ok: false, error: "Invoice not found." }) : json(200, { ok: true, tenantId, item: null });
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
          paidAmount: Number(entity.paidAmount || 0),
          paymentKind: asString(entity.paymentKind),
          jobId: asString(entity.jobId),
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
    const op = asString(body.op || body.operation || body.action).toLowerCase();
    if (authorized && invoiceId && (op === "publish-snapshot" || op === "publishsnapshot" || op === "record-manual-payment")) {
      const attempts = await getTableClient("invoicepaymentattempts");
      releasePaymentLock = await acquireInvoicePaymentLock(attempts, tenantId, invoiceId);
      if (!releasePaymentLock) {
        context.res = json(409, { ok: false, error: "Another payment action is in progress. Refresh the invoice and check its status." });
        return;
      }
      const current = await getEntityIfExists(client, tenantId, invoiceId);
      const attempt = await getEntityIfExists(attempts, tenantId, paymentAttemptKey(invoiceId, current));
      if (current?.pendingReversal || (attempt && attempt.state !== "confirmed")) {
        context.res = json(409, { ok: false, error: "A payment is awaiting reconciliation. Check the payment before changing the invoice." });
        return;
      }
    }
    if (op === "publish-snapshot" || op === "publishsnapshot") {
      if (!authorized) {
        context.res = json(actor ? 403 : 401, { ok: false, error: "Authorized staff session required." });
        return;
      }
      if (!invoiceId) {
        context.res = json(400, { ok: false, error: "invoiceId is required." });
        return;
      }
      const existing = await getEntityIfExists(client, tenantId, invoiceId);
      const publicToken = asString(body.keepExistingToken && existing?.publicToken || body.publicToken);
      if (!publicToken) {
        context.res = json(400, { ok: false, error: "publicToken is required." });
        return;
      }
      const invoiceData = body.invoiceData && typeof body.invoiceData === "object" ? body.invoiceData : {};
      const paymentProvider = asString(body.paymentProvider).toLowerCase();
      const paymentSettings = paymentProvider === "paylynx"
        ? parseJson((await getEntityIfExists(await getTableClient("appsettings"), tenantId, "billing.paymentProviders"))?.valueJson, {}) : {};
      const paylynxMode = paymentSettings.providers?.find(item => item.key === "paylynx")?.mode || "test";
      if (paymentProvider === "paylynx" && !gatewayConfig(tenantId, paylynxMode)) {
        context.res = json(400, { ok: false, error: "PayLynx checkout is unavailable for this workspace." });
        return;
      }
      const amount = sanitizeAmount(body.amount);
      const total = invoicePublishedTotal({ invoiceDataJson: JSON.stringify(invoiceData), returnCreditAmount: existing?.returnCreditAmount });
      if (!amount || amount > total) {
        context.res = json(400, { ok: false, error: "Publish a valid invoice total and outstanding amount." });
        return;
      }
      if (existing?.paymentRevision &&
          Math.round(amount * 100) !== Math.round(total * 100) - Math.round(existing.paidAmount * 100)) {
        context.res = json(409, { ok: false, error: "The invoice payment balance changed. Refresh the invoice before publishing." });
        return;
      }
      const now = new Date().toISOString();
      await client.upsertEntity(
        {
          partitionKey: tenantId,
          rowKey: invoiceId,
          invoiceId,
          publicToken,
          invoiceDataJson: JSON.stringify(invoiceData),
          invoiceNumber: asString(body.invoiceNumber),
          customerName: asString(body.customerName),
          customerEmail: asString(body.customerEmail),
          vehicle: asString(body.vehicle),
          businessName: asString(body.businessName),
          amount: amount.toFixed(2),
          dueDate: asString(body.dueDate),
          paymentUrl: asString(body.paymentUrl),
          snapshotPaymentProvider: paymentProvider,
          snapshotUpdatedAt: now,
          updatedAt: now
        },
        "Merge"
      );
      context.res = json(200, { ok: true, tenantId, invoiceId, publicToken, updatedAt: now });
      return;
    }

    if (!authorized) {
      context.res = json(actor ? 403 : 401, { ok: false, error: "Authorized staff session required to record offline payment." });
      return;
    }
    const action = normalizeAction(body.action);
    if (!invoiceId) {
      context.res = json(400, { ok: false, error: "invoiceId is required." });
      return;
    }
    if (!action) {
      context.res = json(400, { ok: false, error: "action must be `pay`." });
      return;
    }

    if (op !== "record-manual-payment") {
      context.res = json(400, { ok: false, error: "Online payments are recorded by the payment processor." });
      return;
    }

    const amount = sanitizeAmount(body.paymentAmount);
    if (!amount) {
      context.res = json(400, { ok: false, error: "A positive received amount is required." });
      return;
    }
    const current = await getEntityIfExists(client, tenantId, invoiceId);
    if (current?.publicToken && amount !== invoiceBalance(current) &&
        !(current.paymentProvider === "manual" && current.paymentAmount === amount && invoiceBalance(current) === 0)) {
      context.res = json(409, { ok: false, error: "The received amount does not match the published invoice balance." });
      return;
    }
    const replay = current?.paymentProvider === "manual" && current.paymentAmount === amount &&
      (!current.publicToken || invoiceBalance(current) === 0);
    const previousPaid = current?.publicToken ? invoicePreviouslyPaid(current) : 0;
    const payment = {
      ...body,
      invoiceId,
      actor,
      paymentAmount: amount,
      paidAmount: replay ? current.paidAmount : Math.round((previousPaid + amount) * 100) / 100,
      paymentProvider: "manual",
      paymentTransactionId: "",
      paymentKind: replay ? current.paymentKind : (previousPaid > 0 ? "final" : "initial")
    };
    const attempts = await getTableClient("invoicepaymentattempts");
    const attemptKey = paymentAttemptKey(invoiceId, current);
    const existingAttempt = await getEntityIfExists(attempts, tenantId, attemptKey);
    if (existingAttempt) {
      const previousPayment = parseJson(existingAttempt.paymentJson, {});
      if (existingAttempt.state !== "confirmed" || previousPayment.paymentProvider !== "manual" ||
          previousPayment.paymentAmount !== amount) {
        context.res = json(409, { ok: false, error: "An online or different payment is already recorded or pending for this balance." });
        return;
      }
      context.res = json(200, await recordInvoicePayment(tenantId, previousPayment));
      return;
    }
    try {
      await attempts.createEntity({ partitionKey: tenantId, rowKey: attemptKey, state: "confirmed", invoiceId,
        paymentJson: JSON.stringify(payment), createdAt: new Date().toISOString() });
    } catch (error) {
      if (error.statusCode !== 409) throw error;
      context.res = json(409, { ok: false, error: "Another payment was recorded or started. Refresh the invoice." });
      return;
    }
    const result = await recordInvoicePayment(tenantId, payment);
    context.res = json(200, result);
  } catch (err) {
    context.log.error(err);
    context.res = json(500, {
      ok: false,
      error: "Server error.",
      detail: String((err && err.message) || err)
    });
  } finally {
    if (releasePaymentLock) await releasePaymentLock();
  }
};

module.exports.recordInvoicePayment = recordInvoicePayment;
module.exports.invoiceBalance = invoiceBalance;
module.exports.invoicePublishedTotal = invoicePublishedTotal;
module.exports.invoicePreviouslyPaid = invoicePreviouslyPaid;
module.exports.getEntityIfExists = getEntityIfExists;
module.exports.paymentAttemptKey = paymentAttemptKey;
