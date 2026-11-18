import { InvoiceDetail } from '../../services/invoices-data.service';
import InvoiceDetailComponent from './invoice-detail.component';
import QuoteResponseComponent from '../quote-response/quote-response.component';
import InvoicesNewComponent from '../invoices-new/invoices-new.component';

describe('customer-facing quote privacy', () => {
  const detail = {
    id: 'quote-1',
    invoiceNumber: 'Q-1',
    customerName: 'Customer',
    customerNote: 'Please arrive at 7am',
    staffNote: 'PRIVATE STAFF NOTE',
    lineItems: [],
    subtotal: 0,
    taxTotal: 0,
    total: 0
  } as unknown as InvoiceDetail;

  it('keeps the quote SMS short by using the visit link', () => {
    const component = Object.create(InvoicesNewComponent.prototype) as any;
    Object.assign(component, {
      companyName: () => 'Shop', documentLabelLower: () => 'quote', quoteNumberDisplay: () => 'Q-1'
    });
    const link = 'https://example.test/visit/tenant-a#vp_link';
    const sms = component.buildSmsMessage(link);
    expect(sms).toContain(link);
    expect(sms.length).toBeLessThan(200);
    expect(sms).not.toContain('quoteData=');
  });

  it('keeps staff notes out of quote email HTML and public link payloads', () => {
    const component = Object.create(InvoiceDetailComponent.prototype) as InvoiceDetailComponent;
    const email = (component as any).buildQuoteEmailHtml(detail, 'Service Shop', '/visit/tenant-a#vp_link') as string;
    const publicPayload = (component as any).buildPublicQuotePayloadObject(detail) as Record<string, unknown>;

    expect(email).toContain('/visit/tenant-a#vp_link');
    expect(email).toContain('Please arrive at 7am');
    expect(email).not.toContain('PRIVATE STAFF NOTE');
    expect(email).not.toContain('<strong>Terms:</strong>');
    expect(publicPayload['customerNote']).toBe('Please arrive at 7am');
    expect(JSON.stringify(publicPayload)).not.toContain('PRIVATE STAFF NOTE');
  });

  it('ignores staff notes embedded in an older public quote link', () => {
    const component = Object.create(QuoteResponseComponent.prototype) as QuoteResponseComponent;
    const oldPayload = {
      quoteId: 'quote-1',
      customerNote: 'Please arrive at 7am',
      staffNote: 'PRIVATE STAFF NOTE'
    };
    const payload = (component as any).normalizeQuotePayload(oldPayload) as Record<string, unknown>;

    expect(payload['customerNote']).toBe('Please arrive at 7am');
    expect(JSON.stringify(payload)).not.toContain('PRIVATE STAFF NOTE');

    const queryParamMap = {
      keys: ['quoteData'],
      get: () => btoa(JSON.stringify(oldPayload))
    };
    (component as any).route = { snapshot: { queryParamMap } };
    (component as any).quotePayload = () => payload;
    const actionUrl = (component as any).actionUrl('accept') as string;
    const forwardedData = new URL(actionUrl, 'http://localhost').searchParams.get('quoteData') || '';
    const decoded = JSON.parse(atob(forwardedData.replace(/-/g, '+').replace(/_/g, '/')));
    expect(JSON.stringify(decoded)).not.toContain('PRIVATE STAFF NOTE');
  });

  it('keeps staff notes out of new quote-builder public payloads', () => {
    const component = Object.create(InvoicesNewComponent.prototype) as any;
    Object.assign(component, {
      draftId: () => 'quote-1',
      quoteNumberDisplay: () => 'Q-1',
      selectedCustomer: () => null,
      customerDisplayName: () => 'Customer',
      customerVehicleSummary: () => '',
      companyName: () => 'Service Shop',
      companyEmail: () => '',
      companyPhone: () => '',
      companyAddress: () => '',
      logoUrl: () => '',
      quoteDateDisplay: () => '',
      quoteExpirationDisplay: () => '',
      customerNote: () => 'Please arrive at 7am',
      staffNote: () => 'PRIVATE STAFF NOTE',
      quoteSubtotal: () => 0,
      quoteTaxTotal: () => 0,
      quoteGrandTotal: () => 0,
      quoteLineItems: () => []
    });

    const payload = component.quotePublicPayload() as Record<string, unknown>;
    expect(payload['customerNote']).toBe('Please arrive at 7am');
    expect(JSON.stringify(payload)).not.toContain('PRIVATE STAFF NOTE');
  });
});
