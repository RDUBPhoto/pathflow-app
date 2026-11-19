import { signal } from '@angular/core';
import { fakeAsync, tick } from '@angular/core/testing';
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

describe('dragging invoices into Scheduled', () => {
  function board(stage = 'accepted', paidAmount = 100, jobId: string | undefined = 'job-1', customerId = 'customer-1') {
    const component = Object.create(DashboardComponent.prototype) as any;
    const invoiceLane = { id: 'invoices', name: 'Invoices', stageKey: 'invoiced' };
    const scheduledLane = { id: 'scheduled', name: 'Scheduled', stageKey: 'scheduled' };
    const card = { id: 'paid-card', laneId: invoiceLane.id, customerId, jobId, invoiceId: 'invoice-1', title: 'Paid invoice' };
    const original = { invoices: [card], scheduled: [] };
    component.items = signal(original);
    component.lanes = () => [invoiceLane, scheduledLane];
    component.status = signal('');
    component.deferInteractivityRestore = () => {};
    component.linkedDocumentForCard = () => ({ id: 'invoice-1', documentType: 'invoice', stage, total: 100, paidAmount });
    component.effectiveCustomerIdForItem = () => customerId;
    component.openScheduleModal = jasmine.createSpy('openScheduleModal');
    component.hasFutureSchedule = jasmine.createSpy('hasFutureSchedule').and.returnValue(true);
    component.itemsApi = { update: jasmine.createSpy('update') };
    const drop = { previousContainer: { id: invoiceLane.id, data: [card] }, container: { id: scheduledLane.id, data: [] }, previousIndex: 0, currentIndex: 0 };
    return { component, original, drop };
  }

  it('opens the same scheduling modal as the button with the exact paid job and leaves the board unchanged', () => {
    const { component, original, drop } = board();
    component.onCardsDrop(drop, 'scheduled');
    expect(component.openScheduleModal).toHaveBeenCalledOnceWith('customer-1', 'paid-card');
    expect(component.items()).toBe(original);
    expect(component.itemsApi.update).not.toHaveBeenCalled();
    expect(component.hasFutureSchedule).not.toHaveBeenCalled();
  });

  it('keeps customer-only scheduling available for a legacy paid invoice without a job identifier', () => {
    const { component, original, drop } = board('accepted', 100, '');
    component.onCardsDrop(drop, 'scheduled');
    expect(component.openScheduleModal).toHaveBeenCalledOnceWith('customer-1', null);
    expect(component.items()).toBe(original);
  });

  for (const [stage, paidAmount] of [['draft', 0], ['sent', 0], ['accepted', 50], ['canceled', 100]] as const) {
    it(`does not schedule a ${stage} invoice with ${paidAmount} paid against a 100 total`, () => {
      const { component, original, drop } = board(stage, paidAmount);
      component.onCardsDrop(drop, 'scheduled');
      expect(component.status()).toContain('must be paid');
      expect(component.openScheduleModal).not.toHaveBeenCalled();
      expect(component.items()).toBe(original);
      expect(component.itemsApi.update).not.toHaveBeenCalled();
    });
  }

  it('keeps a paid invoice in place when its customer is missing', () => {
    const { component, original, drop } = board('accepted', 100, 'job-1', '');
    component.onCardsDrop(drop, 'scheduled');
    expect(component.status()).toContain('Select a customer');
    expect(component.openScheduleModal).not.toHaveBeenCalled();
    expect(component.items()).toBe(original);
  });
});

describe('drag cleanup between scheduling attempts', () => {
  it('cancels pending cleanup when another drag starts and cleans up after that drag ends', fakeAsync(() => {
    const component = Object.create(DashboardComponent.prototype) as any;
    component.clearResidualDragState = jasmine.createSpy('clearResidualDragState');
    component.deferInteractivityRestore(80);
    component.onCardDragStarted();
    tick(100);
    expect(component.clearResidualDragState).not.toHaveBeenCalled();
    component.onCardDragEnded();
    tick(101);
    expect(component.clearResidualDragState).toHaveBeenCalledTimes(1);
  }));

  it('does not remove the preview or active drag classes while a card is being dragged', () => {
    const component = Object.create(DashboardComponent.prototype) as any;
    component.forceOverlayInteractivityReset = () => {};
    const preview = document.createElement('div'), card = document.createElement('div');
    preview.className = 'cdk-drag-preview'; card.className = 'cdk-drag-dragging';
    document.body.append(preview, card);
    try {
      component.onCardDragStarted();
      component.clearResidualDragState();
      expect(preview.isConnected).toBeTrue();
      expect(card.classList.contains('cdk-drag-dragging')).toBeTrue();
      component.cardDragActive = false;
      component.clearResidualDragState();
      expect(preview.isConnected).toBeFalse();
      expect(card.classList.contains('cdk-drag-dragging')).toBeFalse();
    } finally { preview.remove(); card.remove(); }
  });
});
