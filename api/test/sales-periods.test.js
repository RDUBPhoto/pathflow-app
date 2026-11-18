const test = require("node:test");
const assert = require("node:assert/strict");
const { salesPeriods } = require("../_shared/sales-periods");

test("monthly, quarterly, and yearly sales reconcile invoice, collection, and refund dates independently", () => {
  const docs = [
    { documentType: "invoice", stage: "sent", issueDate: "2026-09-30", total: 120.01, taxTotal: 10,
      refundTransactions: [{ createdAt: "2026-10-03T14:00:00Z", amount: 15 }] },
    { documentType: "invoice", stage: "draft", issueDate: "2026-09-30", total: 800 }
  ];
  const payments = [{ paidAt: "2026-10-01T01:00:00Z", amount: 100.01 }, { paidAt: "2026-10-02T18:00:00Z", amount: 20 }];
  const rows = salesPeriods(docs, payments, "2026-09-01", "2026-12-31", "America/Chicago");
  assert.equal(rows.find(row => row.period === "2026-09").collected, 100.01);
  assert.equal(rows.find(row => row.period === "2026-Q4").refunded, 15);
  assert.deepEqual(rows.find(row => row.period === "2026"),
    { periodType: "year", period: "2026", invoices: 1, invoiced: 120.01, taxes: 10, collected: 120.01, refunded: 15 });
});
