import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { of, Subject } from 'rxjs';
import InvoicePaymentComponent from './invoice-payment.component';
import { InvoiceResponseApiService } from '../../services/invoice-response-api.service';
import { InvoicesDataService } from '../../services/invoices-data.service';
import { ThemeService } from '../../services/theme.service';

describe('payment confirmation integrity', () => {
  function setup(authorize = false) {
    const component = Object.create(InvoicePaymentComponent.prototype) as any;
    Object.assign(component, {
      canCheckout: () => !component.gatewayPending(), isAuthorizeNet: () => authorize, isPaylynx: () => false,
      paymentState: signal('idle'), statusMessage: signal(''),
      gatewayPending: signal(false), refreshedBalanceNeeded: signal(false), confirmedPaidAmount: signal(null), netTotal: () => 10,
      paymentUrl: () => 'https://checkout.example.test/invoice',
      invoiceId: () => 'invoice-1', tenantId: () => 'tenant-a', invoiceNumber: () => 'INV-1',
      publicToken: () => 'payment-token',
      customerName: () => 'Customer', normalizedAmount: () => '10.00',
      cardholderName: () => '', cardNumber: signal('synthetic'), expiryMonth: () => '', expiryYear: () => '',
      cardCode: signal('123'), billingZip: () => '',
      http: { post: jasmine.createSpy('charge') }
    });
    return component;
  }

  function expectNoPayment(c: any) {
    expect(c.paymentState()).not.toBe('paid');
    expect(c.statusMessage()).not.toContain('receipt was emailed');
  }

  it('opening external checkout, including a blocked popup, never marks paid or sends receipts', async () => {
    const c = setup();
    spyOn(window, 'open').and.returnValue(null);
    await c.checkoutAndPay();
    expect(window.open).toHaveBeenCalledWith('https://checkout.example.test/invoice', '_blank', 'noopener,noreferrer');
    expect(c.paymentState()).toBe('awaiting-confirmation');
    expect(c.statusMessage()).toContain('not yet confirmed');
    expect(c.hasPendingAction()).toBeFalse();
    expectNoPayment(c);
  });

  it('rejects unsafe checkout URLs without opening a window', async () => {
    const c = setup();
    c.paymentUrl = () => 'javascript:alert(1)';
    spyOn(window, 'open');
    await c.checkoutAndPay();
    expect(window.open).not.toHaveBeenCalled();
    expect(c.paymentState()).toBe('error');
    expectNoPayment(c);
  });

  for (const response of [ {ok:false, transactionId:'txn'}, {ok:true}, null ]) {
    it(`does not accept unconfirmed processor response ${JSON.stringify(response)}`, async () => {
      const c = setup(true);
      c.http.post.and.returnValue(of(response));
      await c.checkoutAndPay();
      expect(c.paymentState()).toBe('awaiting-confirmation');
      expectNoPayment(c);
    });
  }

  it('blocks duplicate submissions while the gateway result is unknown', async () => {
    const c = setup(true);
    const response = new Subject();
    c.http.post.and.returnValue(response);
    const pending = c.checkoutAndPay();
    await c.checkoutAndPay();
    expect(c.http.post).toHaveBeenCalledTimes(1);
    expect(c.hasPendingAction()).toBeTrue();
    expectNoPayment(c);
    response.error(new Error('Processor unavailable'));
    await pending;
    expect(c.paymentState()).toBe('awaiting-confirmation');
    expect(c.hasPendingAction()).toBeFalse();
    await c.checkoutAndPay();
    expect(c.http.post).toHaveBeenCalledTimes(1);
    expectNoPayment(c);
  });

  it('retains successful direct processor confirmation behavior', async () => {
    const c = setup(true);
    c.http.post.and.returnValue(of({ok:true, transactionId:'confirmed-txn', provider:'authorize-net', receiptSent: true}));
    await c.checkoutAndPay();
    expect(c.http.post).toHaveBeenCalledOnceWith(
      '/api/payment-charge',
      jasmine.objectContaining({ invoiceId: 'invoice-1', publicToken: 'payment-token', amount: '10.00' }),
      { headers: { 'x-tenant-id': 'tenant-a', 'x-skip-action-toast': '1' } }
    );
    expect(c.cardNumber()).toBe('');
    expect(c.cardCode()).toBe('');
    expect(c.statusMessage()).toContain('receipt was emailed');
    expect(c.paymentState()).toBe('paid');
  });

  it('does not treat a paid query parameter as payment confirmation', () => {
    TestBed.configureTestingModule({providers:[
      {provide: ActivatedRoute, useValue:{snapshot:{queryParamMap:convertToParamMap({invoiceId:'invoice-1',paid:'1'})}}},
      {provide: HttpClient, useValue:{}},
      {provide: InvoiceResponseApiService, useValue:{}},
      {provide: InvoicesDataService, useValue:{getInvoiceById:()=>null}},
      {provide: ThemeService, useValue:{mode:signal('light')}}
    ]});
    const component = TestBed.runInInjectionContext(() => new InvoicePaymentComponent());
    expect(component.paymentComplete()).toBeFalse();
  });
});
