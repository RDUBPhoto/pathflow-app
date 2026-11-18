const { createHash } = require("crypto");
const { gatewayConfig, lookupCharge, reverseCharge } = require("../_shared/paylynx");
const { acquireInvoicePaymentLock } = require("../_shared/invoice-payment-lock");
const { resolveStaff } = require("../_shared/staff-access");
const { getEntityIfExists, invoicePreviouslyPaid, invoicePublishedTotal, paymentAttemptKey } = require("../invoice-response");

function cents(value) {
  return Math.round(Number(value) * 100);
}

function fail(status, error, code) {
  return { status, body: { ok: false, error, code } };
}

async function reversePaylynxPayment(req, tenantId, input, table) {
  const { actor, authorized } = await resolveStaff(req, await table("useraccess"), tenantId);
  if (!authorized) return fail(actor ? 403 : 401, "Authorized staff session required.");

  const { invoiceId, originalTransactionId, amount } = input;
  const preview = req.method === "GET";
  const reference = Number(originalTransactionId);
  const alreadyReversed = req.body?.alreadyReversed ?? 0;
  const retainedFee = req.body?.retainedFee ?? 0;
  const creditInvoice = req.body?.creditInvoice === true;
  const reason = String(req.body?.reason || "").trim().slice(0, 256);
  if (!/^[1-9]\d*$/.test(originalTransactionId) || !Number.isSafeInteger(reference) ||
      !Number.isSafeInteger(cents(amount)) || typeof alreadyReversed !== "number" || alreadyReversed < 0 ||
      !Number.isSafeInteger(cents(alreadyReversed)) || cents(alreadyReversed) / 100 !== alreadyReversed) {
    return fail(400, "A valid PayLynx reference and prior reversal amount are required.");
  }
  if (typeof retainedFee !== "number" || !Number.isSafeInteger(cents(retainedFee)) ||
      retainedFee < 0 || retainedFee !== cents(retainedFee) / 100 || (retainedFee && !creditInvoice) ||
      (creditInvoice && !reason)) {
    return fail(400, "Enter a valid fee amount and provide a reason for an invoice return.");
  }

  const [invoices, ledger, attempts] = await Promise.all([
    table("invoiceresponses"), table("paymentledger"), table("invoicepaymentattempts")
  ]);
  const release = preview ? null : await acquireInvoicePaymentLock(attempts, tenantId, invoiceId);
  if (!preview && !release) return fail(409, "Another payment action is in progress. Refresh the invoice and try again.");

  try {
    const key = createHash("sha256").update(`${invoiceId}|paylynx|${originalTransactionId}`).digest("hex");
    const [invoice, original] = await Promise.all([
      getEntityIfExists(invoices, tenantId, invoiceId),
      getEntityIfExists(ledger, tenantId, key)
    ]);
    if (!invoice || original?.provider !== "paylynx" || original.invoiceId !== invoiceId ||
        original.transactionId !== originalTransactionId) {
      return fail(404, "This PayLynx payment is not recorded on the invoice.");
    }
    const mode = original.mode === "live" ? "live" : "test";
    const config = gatewayConfig(tenantId, mode);
    if (!config) return fail(503, "PayLynx credentials for the original payment mode are unavailable.");
    const paid = cents(invoicePreviouslyPaid(invoice));
    const total = cents(invoicePublishedTotal(invoice));
    const history = JSON.parse(invoice.reversalHistoryJson || "[]");
    const priorCents = cents(alreadyReversed);
    const attemptKey = `reverse-${key}-${priorCents}`;
    const existing = history.find(row => row.id === attemptKey);
    if (!preview && existing) {
      if (existing.amount !== amount || Boolean(existing.creditInvoice) !== creditInvoice || (existing.retainedFee || 0) !== retainedFee) {
        return fail(409, "The refundable amount changed. Refresh the invoice.");
      }
      return reversalResult(invoice, existing, mode);
    }
    const paymentAttempt = await getEntityIfExists(attempts, tenantId, paymentAttemptKey(invoiceId, invoice));
    if (paymentAttempt) {
      const payment = JSON.parse(paymentAttempt.paymentJson || "{}");
      if (paymentAttempt.state !== "confirmed" || cents(payment.paidAmount) > paid) {
        return fail(409, "A payment is awaiting reconciliation. Check the invoice payment before reversing it.", "reversal_pending");
      }
    }
    const attempt = preview ? null : await getEntityIfExists(attempts, tenantId, attemptKey);
    if ((invoice.pendingReversal && invoice.pendingReversal !== attemptKey) ||
        (attempt && (attempt.state !== "confirmed" || attempt.amount !== amount))) {
      return fail(409, "A reversal is awaiting reconciliation. Check PayLynx before retrying.", "reversal_pending");
    }
    const reversedCents = history.filter(row => row.originalTransactionId === originalTransactionId)
      .reduce((sum, row) => sum + cents(row.amount), 0);
    const originalCents = cents(original.amount);
    const refundableCents = Math.min(paid, originalCents - reversedCents);
    if (!preview && (reversedCents !== priorCents || cents(amount) + cents(retainedFee) > refundableCents ||
        (creditInvoice && cents(amount) > total))) {
      return fail(409, "The refundable amount changed. Refresh the invoice.", "reversal_changed");
    }

    let reversal = attempt && JSON.parse(attempt.reversalJson);
    const update = { partitionKey: tenantId, rowKey: invoiceId };
    if (!reversal) {
      const charge = await lookupCharge(config, reference);
      if (!charge || cents(charge.amount) !== originalCents) {
        return fail(409, "PayLynx could not verify the original invoice charge.");
      }
      const operation = charge.status === "settled" ? "refund" : "void";
      if (!["settled", "captured", "approved"].includes(charge.status)) {
        return fail(409, `PayLynx cannot reverse a charge with status ${charge.status || "unknown"}.`);
      }
      if (preview) return { status: 200, body: {
        ok: true, operation, originalAmount: originalCents / 100, alreadyReversed: reversedCents / 100,
        refundableAmount: Math.max(0, refundableCents) / 100, invoiceTotal: total / 100
      } };
      if (req.body?.expectedOperation && req.body.expectedOperation !== operation) {
        return fail(409, "The payment settled while you were reviewing it. Open the return again for updated options.", "reversal_changed");
      }
      if (operation === "void" && (cents(amount) !== originalCents || reversedCents !== 0)) {
        return fail(409, "Before settlement, PayLynx can only void the full charge. After settlement, you can issue a partial refund.");
      }

      // Persist the intent before submitting. An ambiguous gateway response requires reconciliation.
      await invoices.upsertEntity({ ...update, pendingReversal: attemptKey }, "Merge");
      await attempts.createEntity({ partitionKey: tenantId, rowKey: attemptKey, invoiceId, amount,
        state: "processing", createdAt: new Date().toISOString() });
      const outcome = await reverseCharge(config, operation, reference, amount);
      if (outcome.state === "declined" || outcome.state === "unauthorized") {
        await attempts.deleteEntity(tenantId, attemptKey);
        await invoices.upsertEntity({ ...update, pendingReversal: "" }, "Merge");
        return outcome.state === "unauthorized"
          ? fail(403, `The PayLynx source needs the ${operation === "void" ? "Void" : "Refund"} permission.`)
          : fail(409, "PayLynx declined the reversal. Check the transaction in PayLynx before retrying.");
      }
      if (outcome.state !== "confirmed") return fail(409, "A reversal is awaiting reconciliation. Check PayLynx before retrying.", "reversal_pending");
      reversal = {
        id: attemptKey, transactionId: outcome.transactionId, originalTransactionId, amount, operation,
        provider: "paylynx", mode, reason, creditInvoice, retainedFee,
        createdAt: new Date().toISOString(), recordedBy: String(actor.email || actor.userId)
      };
      await attempts.upsertEntity({ partitionKey: tenantId, rowKey: attemptKey,
        state: "confirmed", reversalJson: JSON.stringify(reversal) }, "Merge");
    }
    if (Boolean(reversal.creditInvoice) !== creditInvoice || (reversal.retainedFee || 0) !== retainedFee) {
      return fail(409, "Retry with the original return details to finish recording it.", "reversal_pending");
    }
    const paidAmount = (paid - cents(amount)) / 100;
    const credit = creditInvoice ? cents(amount) : 0;
    const balance = Math.max(0, total - credit - paid + cents(amount)) / 100;
    const returnCreditAmount = (cents(invoice.returnCreditAmount || 0) + credit) / 100;
    const next = {
      ...update, action: reversal.operation, stage: balance > 0 ? "sent" : "accepted", paidAmount,
      amount: balance.toFixed(2), returnCreditAmount, paymentRevision: attemptKey, updatedAt: reversal.createdAt,
      reversalHistoryJson: JSON.stringify([...history, reversal]), pendingReversal: ""
    };
    await invoices.upsertEntity(next, "Merge");
    return reversalResult(next, reversal, mode);
  } finally {
    if (release) await release();
  }
}

function reversalResult(invoice, reversal, mode) {
  return { status: 200, body: {
    ok: true, provider: "paylynx", mode, invoiceId: invoice.rowKey,
    originalTransactionId: reversal.originalTransactionId, refundTransactionId: reversal.transactionId,
    amount: reversal.amount.toFixed(2), operation: reversal.operation, paidAmount: invoice.paidAmount,
    returnCreditAmount: Number(invoice.returnCreditAmount || 0), reversal
  } };
}

module.exports = { reversePaylynxPayment };
