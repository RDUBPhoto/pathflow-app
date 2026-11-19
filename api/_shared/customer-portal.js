const { createHash, randomBytes, timingSafeEqual } = require("node:crypto");
const { TableClient, isSqlBackendEnabled } = require("./table-client");
const { invoiceBalance, invoicePreviouslyPaid, invoicePublishedTotal, sanitizeAmount } = require("./invoice-balances");
const { makeShopCalendar, readShopHours } = require("./shop-hours");
const { visitTimeline } = require("./visit-timeline");

const PORTALS = "customerportals";
const GRACE_PERIOD_MS = 30 * 86400000;
const PORTAL_TOKEN = /^vp_([a-f0-9]{24})\.([A-Za-z0-9_-]{32})$/;
const DOCUMENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function text(value) { return String(value ?? "").trim(); }
function json(value, fallback = {}) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}
function time(value) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : 0;
}
function invoiceSource(document) {
  return text(document.sourceQuoteId) || (document.id.startsWith("invoice-") ? document.id.slice(8) : "");
}
function portalKey(root) {
  return createHash("sha256").update(root.documentType + ":" + root.id).digest("hex").slice(0, 24);
}

function connection() {
  return process.env.STORAGE_CONNECTION_STRING || (isSqlBackendEnabled() ? "sql-backend" : "");
}

async function table(name) {
  const client = TableClient.fromConnectionString(connection(), name);
  try { await client.createTable(); } catch (error) { if (error.statusCode !== 409) throw error; }
  return client;
}

async function entity(client, tenant, id) {
  if (!id) return null;
  try { return await client.getEntity(tenant, id); }
  catch (error) { if (error.statusCode !== 404) throw error; return null; }
}

async function rows(name, tenant, field, id) {
  const client = await table(name);
  const safeId = String(id).replace(/'/g, "''");
  const filter = `PartitionKey eq '${tenant}' and ${field} eq '${safeId}'`;
  const list = [];
  for await (const row of client.listEntities({ queryOptions: { filter } })) list.push(row);
  return list;
}

async function documentById(client, tenant, id) {
  if (!DOCUMENT_ID.test(id || "")) return null;
  const row = await entity(client, tenant, id);
  if (!row || row.deleted) return null;
  const document = json(row.documentJson);
  return document.id === id && ["quote", "invoice"].includes(document.documentType) ? document : null;
}

async function portalRoot(client, tenant, doc) {
  if (doc.documentType !== "invoice" || !invoiceSource(doc)) return doc;
  const quote = await documentById(client, tenant, invoiceSource(doc));
  if (!quote) return doc;
  return quote.documentType === "quote" && quote.customerId === doc.customerId ? quote : null;
}

function portalState(record, visit, now = Date.now()) {
  if (record.revoked) return { status: "revoked", expiresAt: "" };
  const { invoiceDoc, invoice, workItem, quoteDoc, quote } = visit;
  const pickedUp = time(workItem?.pickedUpAt);
  const storedTotal = sanitizeAmount(invoiceDoc?.total);
  const savedBalance = invoice?.paymentRevision
    ? Math.max(0, Math.round((storedTotal + sanitizeAmount(invoiceDoc?.returnCreditAmount) -
      sanitizeAmount(invoice.returnCreditAmount) - sanitizeAmount(invoice.paidAmount)) * 100) / 100)
    : Math.max(0, Math.round((storedTotal - Math.max(sanitizeAmount(invoiceDoc?.paidAmount),
      invoice ? invoicePreviouslyPaid(invoice) : 0)) * 100) / 100);
  const canceled = invoiceDoc && ["canceled", "expired"].includes(invoiceDoc.stage);
  const settled = invoiceDoc && !canceled && savedBalance === 0 && (!invoice || invoiceBalance(invoice) === 0);
  const closedAt = time(record.closedAt) || (pickedUp && settled
    ? Math.max(pickedUp, time(invoice?.paidAt || invoiceDoc?.paymentDate), time(invoice?.snapshotUpdatedAt))
    : canceled
      ? Math.max(time(invoiceDoc.updatedAt), pickedUp)
      : !invoiceDoc && ["declined", "canceled", "expired"].includes(quote?.stage || quoteDoc?.stage)
        ? time(quote?.updatedAt || quoteDoc?.updatedAt)
        : 0);
  if (!closedAt) return { status: "active", expiresAt: "" };
  const expires = Math.max(closedAt + GRACE_PERIOD_MS, time(record.extendReadOnlyUntil));
  return { status: expires > now ? "read-only" : "expired", expiresAt: new Date(expires).toISOString(), closedAt };
}

async function loadVisit(tenant, record) {
  const documents = await table("servicedocuments");
  const root = await documentById(documents, tenant, record.documentId);
  if (!root || !record.customerId || root.customerId !== record.customerId) return null;

  const quoteDoc = root.documentType === "quote" ? root : null;
  const invoiceDoc = quoteDoc
    ? await documentById(documents, tenant, record.invoiceId || `invoice-${root.id}`)
    : root;
  const invoiceMatches = invoiceDoc?.documentType === "invoice" && invoiceDoc.customerId === record.customerId &&
    (!quoteDoc || invoiceSource(invoiceDoc) === quoteDoc.id);
  const scopedInvoice = invoiceMatches ? invoiceDoc : null;
  const [quote, invoice] = await Promise.all([
    quoteDoc ? table("quoteresponses").then(client => entity(client, tenant, quoteDoc.id)) : null,
    scopedInvoice ? table("invoiceresponses").then(client => entity(client, tenant, scopedInvoice.id)) : null
  ]);
  let workItem = null;
  if (scopedInvoice) {
    const job = await entity(await table("servicejobs"), tenant, text(invoice?.jobId) || `document:${scopedInvoice.id}`);
    if (job?.invoiceId === scopedInvoice.id) {
      const card = await entity(await table("workitems"), tenant, job.workItemId);
      if (card?.invoiceId === scopedInvoice.id && card.customerId === record.customerId) workItem = card;
    }
  }
  return { quoteDoc, quote, invoiceDoc: scopedInvoice, invoice, workItem };
}

function isPortalToken(token) { return text(token).startsWith("vp_"); }

function portalTokenFromHeader(headers) {
  const value = text(Object.entries(headers || {}).find(([name]) => name.toLowerCase() === "x-visit-token")?.[1]);
  return isPortalToken(value) ? value : "";
}

async function openPortal(tenant, token) {
  const match = PORTAL_TOKEN.exec(text(token));
  if (!match) return null;
  const record = await entity(await table(PORTALS), tenant, match[1]);
  if (!record || !PORTAL_TOKEN.test(record.token || "") ||
      !timingSafeEqual(Buffer.from(record.token), Buffer.from(token)) || record.revoked) return null;
  const visit = await loadVisit(tenant, record);
  if (!visit) return null;
  const state = portalState(record, visit);
  if (state.closedAt && !record.closedAt) {
    await saveClosure(tenant, record, state.closedAt);
  }
  return { ...visit, ...state };
}

async function saveClosure(tenant, record, closedAt) {
  await (await table(PORTALS)).upsertEntity({
    partitionKey: tenant, rowKey: record.rowKey, closedAt: new Date(closedAt).toISOString()
  }, "Merge");
}

async function rememberPortalClosure(tenant, invoiceId) {
  const docs = await table("servicedocuments");
  const invoice = await documentById(docs, tenant, invoiceId);
  if (invoice?.documentType !== "invoice") return;
  const root = await portalRoot(docs, tenant, invoice);
  if (!root) return;
  const record = await entity(await table(PORTALS), tenant, portalKey(root));
  if (!record || record.closedAt) return;
  const visit = await loadVisit(tenant, record);
  if (!visit || visit.invoiceDoc?.id !== invoiceId) return;
  const state = portalState({ ...record, revoked: false }, visit);
  if (state.closedAt) await saveClosure(tenant, record, state.closedAt);
}

function quoteDecisionAllowed(visit) {
  return visit.status === "active" && !!visit.quote?.snapshotUpdatedAt &&
    !visit.invoiceDoc && !["accepted", "declined", "canceled", "expired"].includes(visit.quoteDoc?.stage) &&
    !["accepted", "declined"].includes(visit.quote.stage);
}

function invoiceCheckoutAllowed(visit) {
  return visit.status === "active" && !!visit.invoice?.snapshotUpdatedAt &&
    !["canceled", "expired"].includes(visit.invoiceDoc?.stage);
}

async function allowsPortalAction(tenant, token, kind, id) {
  const visit = await openPortal(tenant, token);
  if (!visit) return false;
  return kind === "quote"
    ? visit.quoteDoc?.id === id && quoteDecisionAllowed(visit)
    : visit.invoiceDoc?.id === id && invoiceCheckoutAllowed(visit);
}

async function managePortal(tenant, id, action) {
  const docs = await table("servicedocuments");
  const document = await documentById(docs, tenant, id);
  if (!document?.customerId) return null;
  const root = await portalRoot(docs, tenant, document);
  if (!root) return null;

  const client = await table(PORTALS);
  const rowKey = portalKey(root);
  let record = await entity(client, tenant, rowKey);
  const belongsToCustomer = record?.customerId === root.customerId;
  if (action === "revoke") {
    if (record && belongsToCustomer) await client.upsertEntity({ partitionKey: tenant, rowKey, revoked: true }, "Merge");
    return { status: "revoked", expiresAt: "" };
  }
  if (record && !belongsToCustomer && action !== "rotate") return { status: "revoked", expiresAt: "" };

  const linkedInvoice = document.documentType === "invoice" ? document.id : record?.invoiceId || "";
  if (!record || action === "rotate") {
    const next = {
      partitionKey: tenant, rowKey, documentId: root.id, customerId: root.customerId, invoiceId: linkedInvoice,
      token: `vp_${rowKey}.${randomBytes(24).toString("base64url")}`, revoked: false, extendReadOnlyUntil: ""
    };
    if (action === "rotate") {
      if (belongsToCustomer && record.closedAt) next.closedAt = record.closedAt;
      next.extendReadOnlyUntil = new Date(Date.now() + GRACE_PERIOD_MS).toISOString();
      await client.upsertEntity(next, "Replace");
      record = next;
    } else {
      try { await client.createEntity(next); record = next; }
      catch (error) {
        if (error.statusCode !== 409) throw error;
        record = await entity(client, tenant, rowKey);
        if (!record || record.customerId !== root.customerId) return { status: "revoked", expiresAt: "" };
      }
    }
  }
  if (!record.revoked && linkedInvoice && record.invoiceId !== linkedInvoice) {
    await client.upsertEntity({ partitionKey: tenant, rowKey, invoiceId: linkedInvoice }, "Merge");
    record = { ...record, invoiceId: linkedInvoice };
  }
  const visit = await loadVisit(tenant, record);
  if (!visit) return null;
  const state = portalState(record, visit);
  return {
    status: state.status, expiresAt: state.expiresAt,
    ...(state.status === "active" || state.status === "read-only"
      ? { path: `/visit/${encodeURIComponent(tenant)}#${record.token}` } : {})
  };
}

function lineItems(data) {
  return Array.isArray(data?.lineItems) ? data.lineItems.map(line => ({
    description: text(line?.description), quantity: sanitizeAmount(line?.quantity),
    total: sanitizeAmount(line?.lineTotal),
    subtotal: sanitizeAmount(line?.lineSubtotal ?? (sanitizeAmount(line?.lineTotal) - sanitizeAmount(line?.taxAmount))),
    unitPrice: sanitizeAmount(line?.unitPrice ?? (sanitizeAmount(line?.quantity) ?
      sanitizeAmount(line?.lineSubtotal ?? line?.lineTotal) / sanitizeAmount(line.quantity) : 0))
  })) : [];
}

function progress(visit) {
  if (visit.workItem?.pickedUpAt) return "Picked up";
  if (visit.workItem?.completedAt) return "Ready for pickup";
  if (visit.workItem?.checkedInAt) return "In the shop";
  if (visit.appointment) return "Scheduled";
  if (visit.workItem) return "Ready to schedule";
  if (visit.invoiceDoc && ["canceled", "expired"].includes(visit.invoiceDoc.stage)) return "Invoice closed";
  if (visit.invoice?.snapshotUpdatedAt) return "Invoice available";
  if (["accepted", "declined"].includes(visit.quote?.stage)) return `Quote ${visit.quote.stage}`;
  return visit.quote?.snapshotUpdatedAt ? "Quote ready" : "Visit created";
}

async function publicSummary(tenant, visit) {
  const { invoiceDoc, invoice, quoteDoc, quote, workItem } = visit;
  const quoteData = json(quote?.quoteDataJson);
  const invoiceData = json(invoice?.invoiceDataJson);
  const invoicePublished = !!invoice?.snapshotUpdatedAt;
  const [payments, appointments, hours] = await Promise.all([
    invoiceDoc ? rows("paymentledger", tenant, "invoiceId", invoiceDoc.id) : [],
    workItem ? rows("schedule", tenant, "workItemId", workItem.rowKey) : [],
    readShopHours(connection(), tenant)
  ]);

  const calendar = makeShopCalendar(hours);
  const scheduled = appointments
    .filter(row => row.customerId === invoiceDoc?.customerId && !row.isBlocked)
    .map(row => ({ start: calendar.parseAppointment(row.start), end: calendar.parseAppointment(row.end) }))
    .filter(row => row.start && row.end)
    .map(row => ({ start: row.start.toISOString(), end: row.end.toISOString(), timeZone: hours.timeZone }))
    .sort((a, b) => time(b.start) - time(a.start));
  const appointment = scheduled.find(row => time(row.end) >= Date.now()) || scheduled[0];
  const history = payments.map(row => ({
    kind: row.paymentKind === "final" ? "Final payment" : "Payment",
    amount: sanitizeAmount(row.amount), date: text(row.paidAt), reference: text(row.transactionId)
  }));
  if (!history.length && invoice?.paidAt && sanitizeAmount(invoice.paidAmount)) {
    history.push({ kind: "Payment", amount: sanitizeAmount(invoice.paidAmount), date: invoice.paidAt,
      reference: text(invoice.paymentTransactionId) });
  }
  const reversals = json(invoice?.reversalHistoryJson, []);
  for (const row of Array.isArray(reversals) ? reversals : []) {
    history.push({ kind: row.operation === "void" ? "Void" : "Refund", amount: sanitizeAmount(row.amount),
      date: text(row.createdAt), reference: text(row.refundTransactionId || row.transactionId || row.originalTransactionId) });
  }
  history.sort((a, b) => time(a.date) - time(b.date));
  const total = invoicePublished ? invoicePublishedTotal(invoice) : sanitizeAmount(invoiceDoc?.total);
  const balance = invoicePublished ? invoiceBalance(invoice) : Math.max(0, total - sanitizeAmount(invoiceDoc?.paidAmount));
  const { timeline, activity } = visitTimeline({ ...visit, appointment, payments: history, total, balance });
  return {
    status: visit.status, expiresAt: visit.expiresAt, progress: progress({ ...visit, appointment }),
    businessName: text(invoice?.businessName || quote?.businessName || invoiceDoc?.businessName || quoteDoc?.businessName),
    businessContact: {
      address: text(invoiceData.businessAddress || quoteData.businessAddress),
      phone: text(invoiceData.businessPhone || quoteData.businessPhone),
      email: text(invoiceData.businessEmail || quoteData.businessEmail)
    },
    customerName: text(invoice?.customerName || quote?.customerName || invoiceDoc?.customerName || quoteDoc?.customerName),
    vehicle: text(invoice?.vehicle || quote?.vehicle || invoiceDoc?.vehicle || quoteDoc?.vehicle),
    appointment: appointment || null,
    activity, timeline,
    quote: quote?.snapshotUpdatedAt ? {
      id: quoteDoc.id, number: text(quote.quoteNumber), stage: text(quote.stage || quoteDoc.stage),
      total: sanitizeAmount(quoteData.total), note: text(quoteData.customerNote), lines: lineItems(quoteData),
      subtotal: sanitizeAmount(quoteData.subtotal ?? (sanitizeAmount(quoteData.total) - sanitizeAmount(quoteData.taxTotal))), tax: sanitizeAmount(quoteData.taxTotal),
      issuedAt: text(quoteData.issueDate || quote.snapshotUpdatedAt),
      canRespond: quoteDecisionAllowed(visit)
    } : null,
    invoice: invoicePublished || history.length ? {
      id: invoiceDoc.id, number: text(invoice?.invoiceNumber || invoiceDoc.invoiceNumber),
      total, balance,
      subtotal: invoicePublished ? sanitizeAmount(invoiceData.subtotal ?? (sanitizeAmount(invoiceData.total) - sanitizeAmount(invoiceData.taxTotal))) : total,
      tax: invoicePublished ? sanitizeAmount(invoiceData.taxTotal) : 0,
      returnCredit: sanitizeAmount(invoice?.returnCreditAmount), note: text(invoiceData.customerNote),
      issuedAt: text(invoiceData.issueDate || invoice?.snapshotUpdatedAt),
      dueDate: text(invoice?.dueDate), lines: invoicePublished ? lineItems(invoiceData) : [],
      canPay: invoiceCheckoutAllowed(visit) && !!text(invoice.snapshotPaymentProvider || invoice.paymentProvider) && invoiceBalance(invoice) > 0
    } : null,
    payments: history
  };
}

module.exports = {
  isPortalToken, portalTokenFromHeader, allowsPortalAction, managePortal, openPortal, publicSummary,
  portalState, rememberPortalClosure, table
};
