const { sanitizeAmount } = require('./invoice-balances');

const validTime = value => Number.isFinite(Date.parse(value || ''));

// Only public milestones belong here. Staff notes and work-clock details stay in the shop.
function visitTimeline({ quoteDoc, quote, invoiceDoc, invoice, workItem, appointment, payments, balance, total }) {
  const quoteAvailable = !!quote?.snapshotUpdatedAt;
  const invoiceAvailable = !!invoice?.snapshotUpdatedAt || payments.length > 0;
  const quoteStage = quote?.stage || quoteDoc?.stage;
  const closedQuote = !invoiceAvailable && ['declined', 'canceled', 'expired'].includes(quoteStage);
  const closedInvoice = ['canceled', 'expired'].includes(invoiceDoc?.stage);
  const received = Math.max(0, Math.round((total - balance) * 100) / 100);
  const receipts = payments.filter(payment => !['Void', 'Refund'].includes(payment.kind));
  const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(sanitizeAmount(value));
  const activity = [];
  const add = (stepId, label, at, extra = {}) => {
    if (validTime(at)) activity.push({ stepId, label, at, ...extra });
  };
  add('quote', 'Quote shared', quote?.snapshotUpdatedAt);
  if (['accepted', 'declined'].includes(quoteStage)) add('quote', `Quote ${quoteStage}`, quote?.updatedAt);
  add('invoice', 'Invoice shared', invoice?.snapshotUpdatedAt);
  payments.forEach((payment, paymentIndex) => add('payment', payment.kind, payment.date, { paymentIndex }));
  add('schedule', 'Appointment', appointment?.start);
  add('work', 'Vehicle checked in', workItem?.checkedInAt);
  add('ready', 'Work completed', workItem?.completedAt);
  add('pickup', 'Vehicle picked up', workItem?.pickedUpAt);
  activity.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const steps = [
    ...(quoteDoc ? [{ id: 'quote', label: 'Quote & approval', icon: 'file-text',
      description: ['declined', 'canceled', 'expired'].includes(quoteStage) ? `Quote ${quoteStage}. Contact the shop if you would like to discuss it.`
        : quoteStage === 'accepted' ? 'Your quote is accepted. You can keep a copy below.'
          : quoteAvailable ? 'Review your quote and let the shop know how you would like to proceed.' : 'The shop is preparing your quote.',
      at: ['accepted', 'declined'].includes(quoteStage) ? quote?.updatedAt : quote?.snapshotUpdatedAt }] : []),
    { id: 'invoice', label: 'Invoice', icon: 'receipt', at: invoice?.snapshotUpdatedAt,
      description: closedInvoice ? 'This invoice is closed. Contact the shop with any questions.'
        : invoiceAvailable ? 'Your shared invoice is available to download.' : 'Your invoice will appear once the shop shares it.' },
    { id: 'payment', label: 'Payment', icon: 'credit-card', at: receipts.at(-1)?.date,
      description: invoiceAvailable ? `${money(received)} applied to your invoice. ${money(balance)} balance due.`
        : 'Payment details and receipts will appear here.' },
    { id: 'schedule', label: 'Scheduled', icon: 'calendar', at: appointment?.start,
      description: appointment ? 'Your appointment is booked. See the appointment details above.' : 'The shop will confirm your appointment here.' },
    { id: 'work', label: 'In the shop', icon: 'tools', at: workItem?.checkedInAt,
      description: workItem?.checkedInAt ? 'Your vehicle has been checked in for its work.' : 'Your visit will update when your vehicle is checked in.' },
    { id: 'ready', label: 'Ready for pickup', icon: 'circle-check', at: workItem?.completedAt,
      description: workItem?.completedAt ? (balance > 0 ? 'Work is complete. Please settle the remaining balance before pickup.' : 'Work is complete. Contact the shop to arrange pickup.')
        : 'The shop will let you know when the work is complete.' },
    { id: 'pickup', label: 'Picked up', icon: 'flag', at: workItem?.pickedUpAt,
      description: workItem?.pickedUpAt ? 'Thank you for choosing us. Your visit paperwork is available below.' : 'Your visit will finish here after vehicle pickup.' }
  ];
  const current = closedInvoice ? 'invoice' : closedQuote ? 'quote'
    : workItem?.pickedUpAt ? 'pickup' : workItem?.completedAt ? 'ready' : workItem?.checkedInAt ? 'work'
      : appointment || workItem || received > 0 ? 'schedule' : invoiceAvailable ? 'payment'
        : quoteStage === 'accepted' ? 'invoice' : quoteDoc ? 'quote' : 'invoice';
  const position = steps.findIndex(step => step.id === current);
  return {
    activity,
    timeline: steps.map((step, index) => ({
      ...step, at: validTime(step.at) ? step.at : '',
      description: index > position && (closedInvoice || closedQuote)
        ? 'This visit is closed. Contact the shop if you would like to plan further work.' : step.description,
      state: index === position && (closedInvoice || closedQuote) ? 'closed'
        : index === position && !workItem?.pickedUpAt ? 'current'
          : index <= position ? 'complete' : 'upcoming',
      events: activity.filter(event => event.stepId === step.id)
    }))
  };
}

module.exports = { visitTimeline };
