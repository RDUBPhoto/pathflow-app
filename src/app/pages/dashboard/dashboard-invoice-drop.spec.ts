import { signal } from '@angular/core';
import DashboardComponent from './dashboard.component';

describe('dragging quotes into Invoices', () => {
  function board(stage = 'accepted', converted = false) {
    const component = Object.create(DashboardComponent.prototype) as any;
    const quoteLane = { id: 'quotes', name: 'Quotes', stageKey: 'quote' };
    const invoiceLane = { id: 'invoices', name: 'Invoices', stageKey: 'invoiced' };
    const card = { id: 'quote-card', laneId: 'quotes', customerId: 'customer-1', title: 'Quote [doc=quote-1]' };
    const original = { quotes: [card], invoices: [] };
    component.items = signal(original);
    component.lanes = () => [quoteLane, invoiceLane];
    component.status = signal('');
    component.deferInteractivityRestore = () => {};
    component.invoicesData = { getInvoiceById: () => ({ id: 'quote-1', documentType: 'quote', stage }) };
    component.convertedQuoteIds = () => new Set(converted ? ['quote-1'] : []);
    component.createInvoiceFromQuoteCard = jasmine.createSpy('createInvoiceFromQuoteCard').and.returnValue(Promise.resolve());
    component.itemsApi = { update: jasmine.createSpy('update') };
    const drop = { previousContainer: { id: 'quotes', data: [card] }, container: { id: 'invoices', data: [] }, previousIndex: 0, currentIndex: 0 };
    return { component, card, quoteLane, original, drop };
  }

  it('uses the existing conversion and send-modal flow instead of a generic lane move', () => {
    const { component, card, quoteLane, original, drop } = board();
    component.onCardsDrop(drop, 'invoices');
    expect(component.createInvoiceFromQuoteCard).toHaveBeenCalledOnceWith(card, quoteLane);
    expect(component.items()).toBe(original);
    expect(component.itemsApi.update).not.toHaveBeenCalled();
  });

  for (const stage of ['draft', 'sent', 'declined', 'canceled', 'expired']) {
    it(`keeps a ${stage} quote in Quotes until it has been accepted`, () => {
      const { component, original, drop } = board(stage);
      component.onCardsDrop(drop, 'invoices');
      expect(component.status()).toContain('must be accepted');
      expect(component.items()).toBe(original);
      expect(component.createInvoiceFromQuoteCard).not.toHaveBeenCalled();
      expect(component.itemsApi.update).not.toHaveBeenCalled();
    });
  }

  it('does not recreate or move back the invoice of an already converted quote', () => {
    const { component, original, drop } = board('accepted', true);
    component.onCardsDrop(drop, 'invoices');
    expect(component.status()).toContain('already has an invoice');
    expect(component.items()).toBe(original);
    expect(component.createInvoiceFromQuoteCard).not.toHaveBeenCalled();
  });

  it('keeps an unlinked card in Quotes and explains what needs to happen', () => {
    const { component, original, drop } = board();
    component.invoicesData.getInvoiceById = () => null;
    component.onCardsDrop(drop, 'invoices');
    expect(component.status()).toContain('Create and accept a quote');
    expect(component.items()).toBe(original);
    expect(component.createInvoiceFromQuoteCard).not.toHaveBeenCalled();
  });
});
