import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import QuoteResponseComponent from './quote-response.component';

describe('public quote response', () => {
  function setup() {
    const component = Object.create(QuoteResponseComponent.prototype) as any;
    const response = new Subject<{ ok: boolean; stage: 'accepted' | 'declined' }>();
    component.selectedAction = signal(null);
    component.responseState = signal('idle');
    component.responseSubmitting = () => component.responseState() === 'submitting';
    component.action = () => component.selectedAction() || 'view';
    component.trackingMessage = signal('');
    component.route = {
      snapshot: {
        queryParamMap: {
          get: (key: string) => key === 'quoteId' ? 'quote-1' : key === 'tenantId' ? 'primary-location' : key === 'publicToken' ? 'quote-token' : null
        }
      }
    };
    component.quotePayload = () => ({ quoteId: 'quote-1' });
    component.quoteNumber = () => 'Q-1';
    component.customerName = () => 'Customer';
    component.vehicle = () => 'Vehicle';
    component.businessName = () => 'Shop';
    component.tenantContext = { tenantId: () => 'primary-location' };
    component.quoteResponseApi = { capture: jasmine.createSpy('capture').and.returnValue(response.asObservable()) };
    component.persistPendingResponse = jasmine.createSpy('persistPendingResponse');
    component.invoicesData = { setStage: jasmine.createSpy('setStage') };
    return { component, response };
  }

  it('blocks duplicate submits and waits for server confirmation before showing success or updating local data', async () => {
    const { component, response } = setup();

    component.submitResponse('accept');
    component.submitResponse('accept');

    expect(component.hasPendingAction()).toBeTrue();
    expect(component.responseState()).toBe('submitting');
    expect(component.quoteResponseApi.capture).toHaveBeenCalledTimes(1);
    expect(component.quoteResponseApi.capture).toHaveBeenCalledWith(jasmine.objectContaining({ publicToken: 'quote-token' }));
    expect(component.persistPendingResponse).not.toHaveBeenCalled();
    expect(component.invoicesData.setStage).not.toHaveBeenCalled();

    response.next({ ok: true, stage: 'accepted' });
    response.complete();
    await Promise.resolve();

    expect(component.hasPendingAction()).toBeFalse();
    expect(component.responseState()).toBe('success');
    expect(component.persistPendingResponse).toHaveBeenCalledTimes(1);
    expect(component.invoicesData.setStage).toHaveBeenCalledWith('quote-1', 'accepted', jasmine.any(String), 'customer');
  });

  it('does not report success when the API rejects the response and allows a retry', async () => {
    const { component, response } = setup();
    component.submitResponse('decline');
    response.error(new Error('Network unavailable'));
    await Promise.resolve();

    expect(component.responseState()).toBe('error');
    expect(component.trackingMessage()).toContain('not confirmed');
    expect(component.persistPendingResponse).not.toHaveBeenCalled();
    expect(component.invoicesData.setStage).not.toHaveBeenCalled();

    const retry = new Subject<{ ok: boolean; stage: 'accepted' | 'declined' }>();
    component.quoteResponseApi.capture.and.returnValue(retry.asObservable());
    component.retryResponse();
    expect(component.responseState()).toBe('submitting');
    expect(component.quoteResponseApi.capture).toHaveBeenCalledTimes(2);
  });

  it('does not treat an unconfirmed success-shaped response as accepted', async () => {
    const { component, response } = setup();
    component.submitResponse('accept');
    response.next({ ok: false, stage: 'accepted' });
    response.complete();
    await Promise.resolve();

    expect(component.responseState()).toBe('error');
    expect(component.persistPendingResponse).not.toHaveBeenCalled();
  });

  it('requests browser leave confirmation only while a response is pending', () => {
    const { component } = setup();
    const event = { preventDefault: jasmine.createSpy('preventDefault'), returnValue: undefined } as any;
    component.onBeforeUnload(event);
    expect(event.preventDefault).not.toHaveBeenCalled();

    component.responseState.set('submitting');
    component.onBeforeUnload(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.returnValue).toBe('');
  });
});
