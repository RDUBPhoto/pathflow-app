const test = require("node:test");
const assert = require("node:assert/strict");
const { portalState, publicSummary } = require("../_shared/customer-portal");
const { visitTimeline } = require("../_shared/visit-timeline");
const { TableClient } = require("../_shared/table-client");

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

const timelineVisit = {
  quoteDoc: { id: 'quote-1' }, quote: { stage: 'accepted', snapshotUpdatedAt: pickup, updatedAt: paid },
  invoiceDoc: { id: 'invoice-1', stage: 'sent' }, invoice: { snapshotUpdatedAt: paid },
  workItem: null, appointment: null, payments: [], total: 125, balance: 125
};
const currentStep = visit => visitTimeline(visit).timeline.find(step => step.state === 'current')?.id;

test('visit timeline advances through payment, scheduling, work and pickup without guessing missing dates', () => {
  assert.equal(currentStep(timelineVisit), 'payment');
  assert.equal(currentStep({ ...timelineVisit, balance: 25 }), 'schedule', 'a deposit can progress to scheduling');
  assert.equal(currentStep({ ...timelineVisit, appointment: { start: paid } }), 'schedule');
  assert.equal(currentStep({ ...timelineVisit, workItem: { checkedInAt: paid } }), 'work');
  const ready = visitTimeline({ ...timelineVisit, workItem: { checkedInAt: pickup, completedAt: paid } });
  assert.equal(ready.timeline.find(step => step.id === 'ready').state, 'current');
  assert.match(ready.timeline.find(step => step.id === 'ready').description, /remaining balance/);
  const done = visitTimeline({ ...timelineVisit, balance: 0, workItem: { pickedUpAt: paid } });
  assert.ok(done.timeline.every(step => step.state === 'complete'));
  assert.equal(ready.timeline.find(step => step.id === 'schedule').at, '', 'no invented appointment date');
});

test('quote-only and closed visits do not imply that the work or payment happened', () => {
  const quoteOnly = { ...timelineVisit, invoiceDoc: null, invoice: null, quote: { stage: 'sent', snapshotUpdatedAt: pickup } };
  assert.equal(currentStep(quoteOnly), 'quote');
  assert.equal(currentStep({ ...quoteOnly, quote: { ...quoteOnly.quote, stage: 'accepted' } }), 'invoice');
  const declined = visitTimeline({ ...quoteOnly, quote: { ...quoteOnly.quote, stage: 'declined', updatedAt: paid } });
  assert.equal(declined.timeline[0].state, 'closed');
  assert.ok(declined.timeline.slice(1).every(step => step.state === 'upcoming'));
  const invoiceOnly = visitTimeline({ ...timelineVisit, quoteDoc: null, quote: null });
  assert.equal(invoiceOnly.timeline[0].id, 'invoice');
  assert.equal(invoiceOnly.timeline.some(step => step.id === 'quote'), false);
});

test('payment timeline preserves individual deposits, final payments and reversal references', () => {
  const payments = [
    { kind: 'Payment', amount: 100, date: pickup },
    { kind: 'Final payment', amount: 25, date: paid },
    { kind: 'Refund', amount: 25, date: '2026-11-19T20:00:00Z' }
  ];
  const result = visitTimeline({ ...timelineVisit, payments, balance: 25 });
  const step = result.timeline.find(step => step.id === 'payment');
  assert.match(step.description, /\$100.00.*\$25.00/);
  assert.deepEqual(step.events.map(event => event.paymentIndex), [0, 1, 2]);
  assert.equal(step.events[2].label, 'Refund');
});

test('public portal paperwork uses published snapshots and excludes unrelated records and staff notes', async t => {
  const tenant = 'portal-paperwork-test';
  t.mock.method(TableClient, 'fromConnectionString', (_, name) => ({
    async createTable() {},
    async getEntity() { throw Object.assign(new Error('Not found'), { statusCode: 404 }); },
    async *listEntities({ queryOptions }) {
      assert.match(queryOptions.filter, new RegExp(`PartitionKey eq '${tenant}'`));
      if (name === 'paymentledger') {
        assert.match(queryOptions.filter, /invoiceId eq 'invoice-1'/);
        yield { amount: 25, paidAt: paid, transactionId: 'public-transaction', paymentKind: 'deposit' };
      }
    }
  }));
  const summary = await publicSummary(tenant, {
    status: 'active', expiresAt: '',
    quoteDoc: { id: 'quote-1', total: 999, staffNote: 'PRIVATE DRAFT' },
    quote: { snapshotUpdatedAt: pickup, stage: 'accepted', updatedAt: paid,
      quoteNumber: 'Q-1', quoteDataJson: JSON.stringify({ total: 100, staffNote: 'PRIVATE QUOTE',
        lineItems: [{ description: 'Published quote work', quantity: 1, lineTotal: 100, staffNote: 'PRIVATE LINE' }] }) },
    invoiceDoc: { id: 'invoice-1', customerId: 'customer-1', total: 999, staffNote: 'PRIVATE INVOICE' },
    invoice: { snapshotUpdatedAt: paid, amount: 75, paidAmount: 25, invoiceNumber: 'INV-1',
      reversalHistoryJson: JSON.stringify([{ operation: 'refund', amount: 5, createdAt: '2026-11-19T20:00:00Z', refundTransactionId: 'refund-reference' }]),
      invoiceDataJson: JSON.stringify({ total: 100, subtotal: 90, taxTotal: 10, customerNote: 'Customer instructions',
        staffNote: 'PRIVATE SNAPSHOT', lineItems: [{ description: 'Published invoice work', quantity: 1, lineTotal: 100 }] }) }
  });
  assert.equal(summary.quote.total, 100);
  assert.equal(summary.quote.subtotal, 100, 'legacy snapshots infer subtotal from published total');
  assert.equal(summary.invoice.total, 100);
  assert.equal(summary.invoice.balance, 75);
  assert.equal(summary.invoice.tax, 10);
  assert.equal(summary.invoice.lines[0].description, 'Published invoice work');
  assert.equal(summary.payments[0].reference, 'public-transaction');
  assert.equal(summary.payments[1].reference, 'refund-reference');
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE|999/);
});
