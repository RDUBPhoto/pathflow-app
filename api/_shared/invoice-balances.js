function sanitizeAmount(value) {
  const normalized = String(value ?? "").trim().replace(/[^0-9.\-]/g, "");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
}

function invoicePublishedTotal(invoice) {
  let total;
  try { total = JSON.parse(invoice?.invoiceDataJson || "{}")?.total; } catch {}
  return Math.max(0, Math.round((sanitizeAmount(total) - sanitizeAmount(invoice?.returnCreditAmount)) * 100) / 100);
}

function invoicePreviouslyPaid(invoice) {
  const atPublication = Math.max(0, invoicePublishedTotal(invoice) - sanitizeAmount(invoice.amount));
  return Math.round(Math.max(atPublication, sanitizeAmount(invoice.paidAmount)) * 100) / 100;
}

function invoiceBalance(invoice) {
  const publishedTotal = invoicePublishedTotal(invoice);
  if (!publishedTotal) return invoice.paidAt ? 0 : sanitizeAmount(invoice.amount);
  return Math.max(0, Math.round((publishedTotal - invoicePreviouslyPaid(invoice)) * 100) / 100);
}

module.exports = { sanitizeAmount, invoicePublishedTotal, invoicePreviouslyPaid, invoiceBalance };
