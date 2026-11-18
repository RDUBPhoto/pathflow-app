const test = require("node:test");
const assert = require("node:assert/strict");
const { portalState } = require("../_shared/customer-portal");

const pickup = "2026-11-17T20:00:00Z";
const paid = "2026-11-18T20:00:00Z";
const settledVisit = {
  invoiceDoc: { total: 100, stage: "accepted" },
  invoice: { invoiceDataJson: '{"total":100}', amount: "100.00", paidAmount: 100, paidAt: paid },
  workItem: { pickedUpAt: pickup }
};

test("portal grace period starts when both pickup and payment are done", () => {
  assert.equal(portalState({}, { ...settledVisit, workItem: {} }).status, "active");
  const unpaid = { ...settledVisit, invoice: { ...settledVisit.invoice, paidAmount: 0, paidAt: "" } };
  assert.equal(portalState({}, unpaid).status, "active");
  assert.equal(portalState({}, {
    ...settledVisit, invoiceDoc: { ...settledVisit.invoiceDoc, total: 125 }
  }).status, "active", "unpublished added work keeps an outstanding balance");
  const now = Date.parse("2026-11-25T00:00:00Z");
  const state = portalState({}, settledVisit, now);
  assert.equal(state.status, "read-only");
  assert.equal(state.expiresAt, "2026-12-18T20:00:00.000Z");
  assert.equal(portalState({}, settledVisit, Date.parse(state.expiresAt)).status, "expired");
  assert.equal(portalState({ revoked: true }, settledVisit, now).status, "revoked");
});

test("an expired link stays closed if the balance subsequently changes", () => {
  const closedAt = paid;
  const unpaid = { ...settledVisit, invoice: { ...settledVisit.invoice, paidAmount: 0, paidAt: "" } };
  assert.equal(portalState({ closedAt }, unpaid, Date.parse("2027-01-01")).status, "expired");
  assert.equal(portalState({ closedAt, extendReadOnlyUntil: "2027-01-31T00:00:00Z" }, unpaid,
    Date.parse("2027-01-01")).status, "read-only", "staff can issue a new link for closed paperwork");
});
