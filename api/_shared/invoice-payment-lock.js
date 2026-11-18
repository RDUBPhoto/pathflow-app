const { createHash } = require("crypto");

async function acquireInvoicePaymentLock(attempts, tenantId, invoiceId) {
  const rowKey = "lock-" + createHash("sha256").update(invoiceId).digest("hex");
  try {
    await attempts.createEntity({ partitionKey: tenantId, rowKey, invoiceId, createdAt: new Date().toISOString() });
  } catch (error) {
    if (error.statusCode === 409) return null;
    throw error;
  }
  return () => attempts.deleteEntity(tenantId, rowKey);
}

module.exports = { acquireInvoicePaymentLock };
