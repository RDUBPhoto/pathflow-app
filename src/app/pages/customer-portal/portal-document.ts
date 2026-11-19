import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { CustomerVisit } from '../../services/customer-portal-api.service';

export type PortalDocumentKind = 'quote' | 'invoice' | 'receipt';
const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value || 0);
const date = (value: string) => {
  const parsed = new Date(value.length === 10 ? value + 'T12:00:00Z' : value);
  return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(parsed) : '';
};

export function portalDocument(visit: CustomerVisit, kind: PortalDocumentKind, paymentIndex?: number): { filename: string; definition: TDocumentDefinitions } | null {
  const document = kind === 'quote' ? visit.quote : visit.invoice;
  const payment = kind === 'receipt' && Number.isInteger(paymentIndex) ? visit.payments[paymentIndex!] : null;
  if (!document || (kind === 'receipt' && !payment)) return null;
  const reversal = payment && ['Refund', 'Void'].includes(payment.kind);
  const title = kind === 'quote' ? 'Quote' : kind === 'invoice' ? 'Invoice'
    : reversal ? `${payment.kind} confirmation` : 'Payment receipt';
  const identifier = String(document.number || document.id).replace(/[^a-z0-9-]/gi, '-');
  const caption = payment ? `${payment.kind} for invoice ${document.number}` : document.number;
  const issued = date(payment?.date || document.issuedAt || '');
  const summary: Content[] = [];
  if (payment) {
    summary.push({ text: money(payment.amount), fontSize: 32, bold: true, color: reversal ? '#a16207' : '#15803d', margin: [0, 4, 0, 18] });
    if (issued) summary.push({ text: `${reversal ? payment.kind + ' date' : 'Received'}: ${issued}`, margin: [0, 0, 0, 10] });
    if (payment.reference) summary.push({ text: `Transaction reference: ${payment.reference}`, margin: [0, 0, 0, 10] });
    summary.push({ text: reversal ? `This confirms a ${payment.kind.toLowerCase()} of the transaction amount shown above.`
      : 'This receipt records this payment. Your visit shows the current invoice balance and any later refunds or voids.', color: '#475569', margin: [0, 12, 0, 0] });
  } else {
    if (issued) summary.push({ text: `Issued: ${issued}`, margin: [0, 0, 0, 8] });
    if (kind === 'invoice' && visit.invoice?.dueDate) summary.push({ text: `Due: ${date(visit.invoice.dueDate)}`, margin: [0, 0, 0, 8] });
    if (kind === 'quote' && visit.quote) summary.push({ text: `Status: ${visit.quote.stage}`, margin: [0, 0, 0, 12] });
    if (document.lines.length) summary.push({
      table: { headerRows: 1, widths: ['*', 30, 70, 75], body: [
        [{ text: 'DESCRIPTION', bold: true }, { text: 'QTY', bold: true, alignment: 'right' }, { text: 'UNIT PRICE', bold: true, alignment: 'right' }, { text: 'AMOUNT', bold: true, alignment: 'right' }],
        ...document.lines.map((line): TableCell[] => [line.description || 'Service',
          { text: String(line.quantity), alignment: 'right' },
          { text: money(line.unitPrice ?? (line.quantity ? (line.subtotal ?? line.total) / line.quantity : 0)), alignment: 'right' },
          { text: money(line.subtotal ?? line.total), alignment: 'right' }])
      ] }, layout: 'lightHorizontalLines', margin: [0, 6, 0, 20]
    });
    const totals: Array<[string, string]> = [];
    if (document.subtotal !== undefined) totals.push(['Subtotal', money(document.subtotal)]);
    if (document.tax !== undefined) totals.push(['Tax', money(document.tax)]);
    if (kind === 'invoice' && visit.invoice?.returnCredit) totals.push(['Return credit', '-' + money(visit.invoice.returnCredit)]);
    totals.push([kind === 'quote' ? 'Quote total' : 'Invoice total', money(document.total)]);
    if (kind === 'invoice' && visit.invoice) {
      totals.push(['Payments applied', money(Math.max(0, document.total - visit.invoice.balance))], ['Balance due', money(visit.invoice.balance)]);
    }
    summary.push({ columns: [{ text: '', width: '*' }, { width: 250, table: { widths: ['*', 'auto'], body: totals.map(([label, value], index) => [
      { text: label, bold: index === totals.length - 1 }, { text: value, alignment: 'right', bold: index === totals.length - 1 }
    ]) }, layout: 'noBorders' }] });
    if (document.note) summary.push({ text: document.note, margin: [0, 24, 0, 0], color: '#475569' });
  }
  return {
    filename: `${kind}-${identifier}${payment ? '-' + (paymentIndex! + 1) : ''}.pdf`,
    definition: {
      pageSize: 'LETTER', pageMargins: [42, 42, 42, 54],
      info: { title: `${title} - ${document.number}`, author: visit.businessName || 'Service shop' },
      defaultStyle: { font: 'Roboto', fontSize: 10, color: '#172033', lineHeight: 1.35 },
      content: [
        { text: visit.businessName || 'Service shop', fontSize: 13, bold: true, color: '#206bc4', margin: [0, 0, 0, 5] },
        { text: [visit.businessContact?.address, visit.businessContact?.phone, visit.businessContact?.email].filter(Boolean).join('\n'), color: '#64748b', fontSize: 9, margin: [0, 0, 0, 18] },
        { text: title, fontSize: 28, bold: true },
        { text: caption, fontSize: 12, color: '#475569', margin: [0, 3, 0, 20] },
        { text: visit.customerName || 'Customer', bold: true },
        { text: visit.vehicle || 'Service visit', color: '#475569', margin: [0, 3, 0, 22] },
        ...summary
      ],
      footer: (page, count) => ({ text: `${visit.businessName || 'Service shop'}  |  ${document.number}  |  ${page} / ${count}`, alignment: 'center', fontSize: 8, color: '#64748b', margin: [42, 15, 42, 0] })
    }
  };
}

export async function downloadPortalDocument(document: NonNullable<ReturnType<typeof portalDocument>>): Promise<void> {
  // Lazy loading keeps the PDF engine and embedded fonts out of the initial portal download.
  const [{ default: pdfMake }, { default: fonts }] = await Promise.all([import('pdfmake/build/pdfmake'), import('pdfmake/build/vfs_fonts')]);
  pdfMake.addVirtualFileSystem(fonts);
  await pdfMake.createPdf(document.definition).download(document.filename);
}
