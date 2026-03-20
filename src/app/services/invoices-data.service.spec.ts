import { TestBed } from '@angular/core/testing';
import { AuthService } from '../auth/auth.service';
import { TenantContextService } from './tenant-context.service';
import { InvoicesDataService } from './invoices-data.service';

describe('InvoicesDataService', () => {
  let service: InvoicesDataService;

  beforeEach(() => {
    localStorage.clear();

    const authStub = {
      user: () => ({
        id: 'qa-user-1',
        email: 'qa@example.com',
        displayName: 'QA User',
        identityProvider: 'dev-local',
        roles: ['admin']
      }),
      locations: () => [],
      defaultLocationId: () => 'main'
    } as unknown as AuthService;

    const tenantStub = {
      tenantId: () => 'main'
    } as unknown as TenantContextService;

    TestBed.configureTestingModule({
      providers: [
        InvoicesDataService,
        { provide: AuthService, useValue: authStub },
        { provide: TenantContextService, useValue: tenantStub }
      ]
    });

    service = TestBed.inject(InvoicesDataService);
  });

  it('creates a quote draft with calculated totals', () => {
    const quote = service.createDraftInvoice({
      documentType: 'quote',
      customerName: 'QA Customer',
      customerEmail: 'customer@example.com',
      lineItems: [
        {
          type: 'part',
          description: 'Winch kit',
          quantity: 2,
          unitPrice: 100,
          taxRate: 8.25
        }
      ]
    });

    expect(quote.documentType).toBe('quote');
    expect(quote.invoiceNumber.startsWith('QTE-')).toBeTrue();
    expect(quote.subtotal).toBe(200);
    expect(quote.taxTotal).toBe(16.5);
    expect(quote.total).toBe(216.5);
    expect(service.forCustomer({ email: 'customer@example.com' }).length).toBe(1);
  });

  it('converts an accepted quote into a draft invoice and cancels original quote', () => {
    const quote = service.createDraftInvoice({
      documentType: 'quote',
      stage: 'accepted',
      customerName: 'QA Customer',
      customerEmail: 'customer@example.com',
      lineItems: [
        {
          type: 'labor',
          description: 'Install labor',
          quantity: 1,
          unitPrice: 250,
          taxRate: 0
        }
      ]
    });

    const createdInvoice = service.createInvoiceFromQuote(quote.id);

    expect(createdInvoice).not.toBeNull();
    expect(createdInvoice?.documentType).toBe('invoice');
    expect(createdInvoice?.stage).toBe('draft');

    const refreshedQuote = service.getInvoiceById(quote.id);
    expect(refreshedQuote?.stage).toBe('canceled');
  });

  it('records refunds in timeline without changing total', () => {
    const invoice = service.createDraftInvoice({
      documentType: 'invoice',
      customerName: 'Refund Customer',
      lineItems: [
        {
          type: 'part',
          description: 'Part',
          quantity: 1,
          unitPrice: 50,
          taxRate: 0
        }
      ]
    });

    const refunded = service.recordRefund(invoice.id, 15, 'Damaged item');

    expect(refunded).not.toBeNull();
    expect(refunded?.total).toBe(50);
    expect(refunded?.timeline.some(item => item.message.includes('Refund issued: $15.00. Damaged item'))).toBeTrue();
  });
});
