import { signal } from '@angular/core';
import DashboardComponent from './dashboard.component';

describe('dashboard notification read state', () => {
  function board(hints: object[]) {
    const component = Object.create(DashboardComponent.prototype) as any;
    Object.assign(component, {
      seenLeadsLoaded: true, seenLeadsInitialized: true, seenCardsLoaded: true, seenCardsInitialized: true,
      seenLeadIds: signal({}), seenCardIds: signal({}),
      lanes: signal([{ id: 'invoices', stageKey: 'invoice' }, { id: 'scheduled', stageKey: 'scheduled' }]),
      invoicesData: { getInvoiceById: (id: string) => ({ id, documentType: 'invoice', invoiceNumber: id.toUpperCase() }) },
      notificationsApi: { openedHints: () => hints, saveOpenedHints: jasmine.createSpy('saveHints'),
        acknowledgeView: jasmine.createSpy('acknowledgeView') },
      persistSeenLeadsNow: jasmine.createSpy('persistLeads'), persistSeenCardsNow: jasmine.createSpy('persistCards')
    });
    return component;
  }

  it('opening an invoice clears only its card, not another invoice for the same customer or a later stage', () => {
    const openedAt = new Date().toISOString();
    const component = board([{ entityType: 'invoice', entityId: 'invoice-1', metadata: { customerId: 'customer-1' }, openedAt }]);
    const map = {
      invoices: [
        { id: 'card-1', customerId: 'customer-1', invoiceId: 'invoice-1' },
        { id: 'card-2', customerId: 'customer-1', invoiceId: 'invoice-2' }
      ],
      scheduled: [{ id: 'card-1', customerId: 'customer-1', invoiceId: 'invoice-1', updatedAt: new Date(Date.now() + 60000).toISOString() }]
    };
    component.applyOpenedNotificationSeenHints(map);
    expect(component.seenCardIds()).toEqual({ 'card-1::invoices': true });
    component.applyOpenedNotificationSeenHints(map);
    expect(component.persistSeenCardsNow).toHaveBeenCalledTimes(1);
  });

  it('an actual card interaction acknowledges the linked document even before seen preferences load', () => {
    const component = board([]);
    component.seenCardsLoaded = false;
    component.markCardSeen({ id: 'card-1', laneId: 'invoices', invoiceId: 'invoice-1' });
    expect(component.notificationsApi.acknowledgeView).toHaveBeenCalledWith([
      { type: 'workitem', id: 'card-1' }, { type: 'lead', id: 'card-1' },
      { type: 'invoice', id: 'invoice-1', number: 'INVOICE-1' }
    ]);
  });
});
