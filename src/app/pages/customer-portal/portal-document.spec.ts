import { CustomerVisit } from '../../services/customer-portal-api.service';
import { portalDocument } from './portal-document';

describe('customer portal paperwork', () => {
  const visit = {
    businessName: 'Service Shop', customerName: 'José Customer', vehicle: '2024 Jeep Wrangler',
    quote: { id: 'quote-1', number: 'Q-1', stage: 'accepted', total: 108.25, subtotal: 100, tax: 8.25,
      lines: [{ description: 'Published installation', quantity: 1, total: 108.25 }], note: 'Bring your keys' },
    invoice: { id: 'invoice-1', number: 'INV-1', total: 100, subtotal: 100, tax: 8.25, returnCredit: 8.25, balance: 25,
      lines: [{ description: 'Published installation', quantity: 1, total: 108.25 }] },
    payments: [
      { kind: 'Payment', amount: 75, date: '2026-11-19T15:00:00Z', reference: 'deposit-1' },
      { kind: 'Final payment', amount: 25, date: '2026-11-20T15:00:00Z', reference: 'final-1' },
      { kind: 'Void', amount: 25, date: '2026-11-20T16:00:00Z' }
    ], staffNote: 'PRIVATE STAFF NOTE', publicToken: 'PRIVATE TOKEN'
  } as unknown as CustomerVisit;

  it('downloads only available quote/invoice snapshots and never includes staff notes or access tokens', () => {
    for (const kind of ['quote', 'invoice'] as const) {
      const result = portalDocument(visit, kind)!;
      expect(result.filename).toBe(kind === 'quote' ? 'quote-Q-1.pdf' : 'invoice-INV-1.pdf');
      const contents = JSON.stringify(result.definition);
      expect(contents).toContain('Published installation');
      expect(contents).toContain('José Customer');
      expect(contents).not.toContain('PRIVATE');
    }
    expect(portalDocument({ ...visit, invoice: null }, 'invoice')).toBeNull();
    expect(portalDocument({ ...visit, quote: null }, 'quote')).toBeNull();
  });

  it('keeps each receipt amount and reference separate from the current invoice balance', () => {
    const deposit = portalDocument(visit, 'receipt', 0)!;
    const final = portalDocument(visit, 'receipt', 1)!;
    expect(deposit.filename).toBe('receipt-INV-1-1.pdf');
    expect(final.filename).toBe('receipt-INV-1-2.pdf');
    expect(JSON.stringify(deposit.definition)).toContain('$75.00');
    expect(JSON.stringify(deposit.definition)).toContain('deposit-1');
    expect(JSON.stringify(deposit.definition)).not.toContain('final-1');
    expect(JSON.stringify(final.definition)).toContain('$25.00');
    expect(JSON.stringify(portalDocument(visit, 'receipt', 2)!.definition)).toContain('Void confirmation');
    expect(portalDocument(visit, 'receipt', 9)).toBeNull();
    expect(portalDocument(visit, 'receipt', -1)).toBeNull();
  });

  it('includes invoice tax, return credits, applied payments and the remaining balance', () => {
    const invoice = JSON.stringify(portalDocument(visit, 'invoice')!.definition);
    for (const label of ['Tax', 'Return credit', 'Payments applied', 'Balance due', '$25.00', '$75.00', '-$8.25']) expect(invoice).toContain(label);
  });
});
