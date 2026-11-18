import { signal } from '@angular/core';
import { CanDeactivateFn } from '@angular/router';
import { routes } from '../../app.routes';
import InvoicePaymentComponent from './invoice-payment.component';

describe('public invoice action navigation', () => {
  it('blocks route and browser navigation while payment is processing', () => {
    const component = Object.create(InvoicePaymentComponent.prototype) as any;
    component.paymentState = signal('processing');
    expect(component.hasPendingAction()).toBeTrue();

    const event = { preventDefault: jasmine.createSpy('preventDefault'), returnValue: undefined } as any;
    component.onBeforeUnload(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.returnValue).toBe('');

    for (const path of ['quote-response', 'quote-accepted', 'quote-declined', 'invoice-payment']) {
      const route = routes.find(candidate => candidate.path === path);
      const guard = route?.canDeactivate?.[0] as CanDeactivateFn<{ hasPendingAction(): boolean }>;
      expect(guard).toBeDefined();
      expect(guard(component, {} as any, {} as any, {} as any)).toBeFalse();
    }

    component.paymentState.set('paid');
    expect(component.hasPendingAction()).toBeFalse();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    const invoiceRoute = routes.find(candidate => candidate.path === 'invoice-payment');
    const guard = invoiceRoute?.canDeactivate?.[0] as CanDeactivateFn<{ hasPendingAction(): boolean }>;
    expect(guard(component, {} as any, {} as any, {} as any)).toBeTrue();
  });
});
