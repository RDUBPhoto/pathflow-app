const { randomUUID } = require("crypto");
const { TableClient, isSqlBackendEnabled } = require("../_shared/table-client");
const { resolveTenantId } = require("../_shared/tenant");
const { resolveStaff } = require("../_shared/staff-access");

const TABLE = "servicedocuments";

function response(status, body) {
  return { status, headers: { "content-type": "application/json", "cache-control": "no-store" }, body };
}

async function table(name) {
  const connection = process.env.STORAGE_CONNECTION_STRING || (isSqlBackendEnabled() ? "sql-backend" : "");
  if (!connection) throw new Error("Document storage is not configured.");
  const client = TableClient.fromConnectionString(connection, name);
  try { await client.createTable(); } catch (error) { if (error.statusCode !== 409) throw error; }
  return client;
}

async function listDocuments(tenantId) {
  const [client, quotes, invoices, ledger] = await Promise.all([
    table(TABLE), table("quoteresponses"), table("invoiceresponses"), table("paymentledger")
  ]);
  const documents = [];
  const filter = `PartitionKey eq '${tenantId}'`;
  async function byId(source) {
    const result = new Map();
    for await (const row of source.listEntities({ queryOptions: { filter } })) result.set(row.rowKey, row);
    return result;
  }
  const [rows, quoteResponses, invoiceResponses, payments] = await Promise.all([
    byId(client), byId(quotes), byId(invoices), byId(ledger)
  ]);
  const paylynxPayments = new Map();
  for (const payment of payments.values()) {
    if (payment.provider !== "paylynx") continue;
    const items = paylynxPayments.get(payment.invoiceId) || [];
    items.push({ provider: "paylynx", transactionId: payment.transactionId, amount: payment.amount,
      accountNumber: payment.accountNumber, createdAt: payment.paidAt });
    paylynxPayments.set(payment.invoiceId, items);
  }
  for (const row of rows.values()) {
    const document = row.deleted ? null : JSON.parse(row.documentJson);
    if (document?.documentType === "quote" && ["sent", "accepted", "declined"].includes(document.stage)) {
      const decision = quoteResponses.get(row.rowKey);
      if (["accepted", "declined"].includes(decision?.stage)) document.stage = decision.stage;
    }
    if (document?.documentType === "invoice" && !["canceled", "expired"].includes(document.stage)) {
      const payment = invoiceResponses.get(row.rowKey);
      if (payment?.paymentRevision) {
        const gross = Number(document.total || 0) + Number(document.returnCreditAmount || 0);
        document.returnCreditAmount = Number(payment.returnCreditAmount || 0);
        document.total = Math.max(0, Math.round((gross - document.returnCreditAmount) * 100) / 100);
        document.paidAmount = payment.paidAmount;
        const balanceDue = Math.round((Number(document.total) - Number(payment.paidAmount)) * 100) > 0;
        document.paymentDate = balanceDue ? "" : payment.paidAt?.slice(0, 10);
        document.stage = balanceDue ? "sent" : document.stage === "completed" ? "completed" : "accepted";
        document.refundTransactions ||= [];
        document.timeline ||= [];
        for (const reversal of JSON.parse(payment.reversalHistoryJson || "[]")) {
          if (!document.refundTransactions.some(item => item.provider === reversal.provider && item.transactionId === reversal.transactionId)) {
            document.refundTransactions.push(reversal);
          }
          if (!document.timeline.some(item => item.id === reversal.id)) {
            document.timeline.push({
              id: reversal.id, createdAt: reversal.createdAt, actorType: "system", createdBy: reversal.recordedBy,
              message: `PayLynx payment ${reversal.operation === "void" ? "voided" : "refunded"} for $${reversal.amount.toFixed(2)}.` +
                (reversal.creditInvoice ? " Invoice credited." : "") +
                (reversal.retainedFee ? ` Fee retained $${reversal.retainedFee.toFixed(2)}.` : "") +
                (reversal.reason ? ` ${reversal.reason}` : "")
            });
          }
        }
      } else if (payment?.paidAt && Number(payment.paidAmount) > Number(document.paidAmount || 0)) {
        document.paidAmount = payment.paidAmount;
        document.paymentDate ||= payment.paidAt.slice(0, 10);
        if (document.stage !== "completed" && payment.paidAmount >= document.total) document.stage = "accepted";
      }
      const transactions = paylynxPayments.get(row.rowKey) || [];
      if (payment?.paidAt && payment.paymentProvider === "paylynx" && payment.paymentTransactionId &&
          !transactions.some(item => item.transactionId === payment.paymentTransactionId)) {
        transactions.push({ provider: "paylynx", transactionId: payment.paymentTransactionId, amount: payment.paymentAmount,
          accountNumber: payment.paymentAccountNumber, createdAt: payment.paidAt });
      }
      for (const transaction of transactions) {
        document.paymentTransactions ||= [];
        if (!document.paymentTransactions.some(item => item.provider === transaction.provider && item.transactionId === transaction.transactionId)) {
          document.paymentTransactions.push(transaction);
        }
      }
      if (payment?.paidAt && payment.paymentProvider === "authorize-net" && payment.paymentTransactionId) {
        document.paymentTransactions ||= [];
        if (!document.paymentTransactions.some(item => item.transactionId === payment.paymentTransactionId)) {
          document.paymentTransactions.push({
            provider: payment.paymentProvider, transactionId: payment.paymentTransactionId,
            amount: payment.paymentAmount, accountNumber: payment.paymentAccountNumber, createdAt: payment.paidAt
          });
        }
      }
    }
    documents.push({
      id: row.rowKey,
      revision: row.revision,
      document
    });
  }
  return documents;
}

module.exports = async function (context, req) {
  const tenantId = resolveTenantId(req, req.body);
  try {
    const { actor, authorized } = await resolveStaff(req, await table("useraccess"), tenantId);
    if (!authorized) {
      context.res = response(actor ? 403 : 401, { error: "Authorized staff session required." });
      return;
    }
    if (req.method === "GET") {
      context.res = response(200, { items: await listDocuments(tenantId) });
      return;
    }
    const { id, revision, document } = req.body || {};
    const deleted = document === null;
    if (typeof id !== "string" || !/^[a-zA-Z0-9._:-]{1,128}$/.test(id) || id in Object.prototype ||
        (!deleted && (!document || document.id !== id ||
          !["quote", "invoice"].includes(document.documentType))) ||
        (revision != null && (typeof revision !== "string" || !/^[0-9a-f-]{36}$/.test(revision)))) {
      context.res = response(400, { error: "A valid quote or invoice and revision are required." });
      return;
    }
    const documentJson = deleted ? "" : JSON.stringify(document);
    if (Buffer.byteLength(documentJson, "utf16le") > 64000) {
      context.res = response(400, { error: "This document exceeds the shared storage limit." });
      return;
    }
    const client = await table(TABLE);
    const entity = {
      partitionKey: tenantId, rowKey: id, revision: randomUUID(), documentJson, deleted,
      changedAt: new Date().toISOString(), changedBy: String(actor.email || actor.userId)
    };
    try {
      if (!revision) {
        await client.createEntity(entity);
      } else if (typeof client.replaceIfRevision === "function") {
        if (!await client.replaceIfRevision(entity, revision)) throw Object.assign(new Error("Conflict"), { statusCode: 412 });
      } else {
        const current = await client.getEntity(tenantId, id);
        if (current.revision !== revision) throw Object.assign(new Error("Conflict"), { statusCode: 412 });
        await client.updateEntity(entity, "Replace", { etag: current.etag });
      }
    } catch (error) {
      if (![404, 409, 412].includes(error.statusCode)) throw error;
      context.res = response(409, { error: "Another session changed this document. Your local edit has been kept." });
      return;
    }
    context.res = response(200, { id, revision: entity.revision });
  } catch (error) {
    context.log?.error?.("Shared document operation failed.");
    context.res = response(503, { error: "Shared documents are temporarily unavailable." });
  }
};

module.exports.listDocuments = listDocuments;
