function cents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0;
}

function salesPeriods(documents, payments, from, to, timeZone) {
  const rows = new Map();
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  function dateKey(value) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return value;
    const date = new Date(value || "");
    if (!Number.isFinite(date.getTime())) return "";
    const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }
  function add(date, changes) {
    const key = dateKey(date);
    if (!key || key < from || key > to) return;
    const year = key.slice(0, 4);
    const quarter = `${year}-Q${Math.ceil(Number(key.slice(5, 7)) / 3)}`;
    for (const [periodType, period] of [["month", key.slice(0, 7)], ["quarter", quarter], ["year", year]]) {
      const row = rows.get(period) || { periodType, period, invoices: 0, invoiced: 0, taxes: 0, collected: 0, refunded: 0 };
      for (const [field, amount] of Object.entries(changes)) row[field] += amount;
      rows.set(period, row);
    }
  }
  for (const document of documents) {
    if (!document || document.documentType !== "invoice" || !["sent", "accepted", "completed"].includes(document.stage)) continue;
    add(document.issueDate, { invoices: 1, invoiced: cents(document.total), taxes: cents(document.taxTotal) });
    for (const refund of document.refundTransactions || []) add(refund.createdAt, { refunded: cents(refund.amount) });
  }
  for (const payment of payments) add(payment.paidAt, { collected: cents(payment.amount) });
  return [...rows.values()].sort((a, b) => a.period.localeCompare(b.period)).map(row => ({
    ...row, invoiced: row.invoiced / 100, taxes: row.taxes / 100, collected: row.collected / 100, refunded: row.refunded / 100
  }));
}

module.exports = { salesPeriods };
