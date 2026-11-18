import { UiIcon } from '../../ui/icons';

import { Component, ElementRef, HostListener, OnDestroy, ViewChild, computed, effect, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom, from, timeout } from 'rxjs';
import { InvoiceResponseApiService } from '../../services/invoice-response-api.service';
import { InvoiceLineItem, InvoicesDataService } from '../../services/invoices-data.service';
import { ThemeService } from '../../services/theme.service';
import { loadPaylynxTokenization, paylynxFieldStyles, type PaylynxCardForm } from './paylynx-tokenization';

type PaymentState = 'idle' | 'processing' | 'awaiting-confirmation' | 'paid' | 'error';
const COMPACT_CARD_FIELDS_WIDTH = 350;
type PaymentChargeResponse = {
  ok: boolean;
  provider: string;
  mode?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  amount?: string;
  transactionId?: string;
  paidAmount?: number;
  receiptSent?: boolean;
};

type InvoicePaymentPayload = {
  jobNumber?: string;
  customerId?: string;
  subtotal?: number;
  taxTotal?: number;
  total?: number;
  lineItems?: InvoiceLineItem[];
};

@Component({
  selector: 'app-invoice-payment',
  standalone: true,
  imports: [UiIcon, FormsModule, RouterLink],
  templateUrl: './invoice-payment.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./invoice-payment.component.scss']
})
export default class InvoicePaymentComponent implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);
  private readonly invoiceResponseApi = inject(InvoiceResponseApiService);
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly theme = inject(ThemeService);
  private readonly remoteSnapshot = signal<Record<string, unknown> | null>(null);
  readonly paylynxMode = signal<'test' | 'live'>('test');
  private staffTokenizationKey = '';
  private staffPaymentPending = false;

  readonly staffCharge = this.route.snapshot.data?.['staffCharge'] === true;
  readonly invoiceId = computed(() => String((this.staffCharge ? this.route.snapshot.paramMap.get('id')
    : this.route.snapshot.queryParamMap.get('invoiceId')) || '').trim());
  readonly publicToken = computed(() => {
    const fragment = this.route.snapshot.fragment || '';
    return String(this.route.snapshot.queryParamMap.get('publicToken') || (fragment.startsWith('vp_') ? fragment : '')).trim();
  });
  readonly fromCustomerPortal = computed(() => !this.staffCharge && this.publicToken().startsWith('vp_'));
  readonly tenantId = computed(() => String(this.route.snapshot.queryParamMap.get('tenantId') || '').trim().toLowerCase() || 'main');
  readonly invoiceNumber = computed(() => String(this.remoteSnapshot() ? this.remoteValue('invoiceNumber') : this.route.snapshot.queryParamMap.get('invoiceNumber') || '').trim() || 'Invoice');
  readonly customerName = computed(() => String(this.remoteSnapshot() ? this.remoteValue('customerName') : this.route.snapshot.queryParamMap.get('customerName') || '').trim() || 'Customer');
  readonly vehicle = computed(() => String(this.remoteSnapshot() ? this.remoteValue('vehicle') : this.route.snapshot.queryParamMap.get('vehicle') || '').trim() || 'Vehicle details pending');
  readonly businessName = computed(() => String(this.remoteSnapshot() ? this.remoteValue('businessName') : this.route.snapshot.queryParamMap.get('businessName') || '').trim() || 'Our team');
  readonly amount = computed(() => String(this.remoteSnapshot() ? this.remoteValue('amount') : this.route.snapshot.queryParamMap.get('amount') || '').trim() || '');
  readonly dueDate = computed(() => String(this.remoteSnapshot() ? this.remoteValue('dueDate') : this.route.snapshot.queryParamMap.get('dueDate') || '').trim() || '');
  readonly paymentUrl = computed(() => String(this.remoteSnapshot() ? this.remoteValue('paymentUrl') : this.route.snapshot.queryParamMap.get('paymentUrl') || '').trim());
  readonly paymentProvider = computed(() => String(this.remoteSnapshot() ? this.remoteValue('paymentProvider') : this.route.snapshot.queryParamMap.get('paymentProvider') || '').trim().toLowerCase());
  readonly isPaylynx = computed(() => !!this.remoteSnapshot() && this.paymentProvider() === 'paylynx');
  readonly isAuthorizeNet = computed(() => !this.isPaylynx() &&
    (this.paymentProvider() === 'authorize-net' || this.paymentUrl().includes('/authorize-net/')));
  readonly detail = computed(() => this.publicToken() || this.staffCharge ? null : this.invoicesData.getInvoiceById(this.invoiceId()));
  readonly invoicePayload = computed<InvoicePaymentPayload | null>(() => this.normalizeInvoicePayload(this.remoteSnapshot()?.['invoiceData']) || this.decodeInvoicePayload(this.route.snapshot.queryParamMap.get('invoiceData')));
  readonly businessLogoUrl = computed(() => String(this.detail()?.businessLogoUrl || '').trim());
  readonly businessAddressLines = computed(() => this.toAddressLines(String(this.detail()?.businessAddress || '')));
  readonly customerAddressLines = computed(() => this.toAddressLines(String(this.detail()?.customerAddress || '')));
  readonly lineItems = computed<InvoiceLineItem[]>(() => this.detail()?.lineItems || this.invoicePayload()?.lineItems || []);
  readonly displaySubtotal = computed(() => {
    const fromDetail = Number(this.detail()?.subtotal || 0);
    if (fromDetail > 0) return fromDetail;
    const fromPayload = Number(this.invoicePayload()?.subtotal || 0);
    if (fromPayload > 0) return fromPayload;
    return this.roundCurrency(this.lineItems().reduce((sum, item) => sum + Number(item.lineSubtotal || 0), 0));
  });
  readonly displayTax = computed(() => {
    const fromDetail = Number(this.detail()?.taxTotal || 0);
    if (fromDetail > 0) return fromDetail;
    const fromPayload = Number(this.invoicePayload()?.taxTotal || 0);
    if (fromPayload > 0) return fromPayload;
    return this.roundCurrency(this.lineItems().reduce((sum, item) => sum + Number(item.taxAmount || 0), 0));
  });
  readonly displayTotal = computed(() => {
    const fromDetail = Number(this.detail()?.total || 0);
    if (fromDetail > 0) return fromDetail;
    const fromPayload = Number(this.invoicePayload()?.total || 0);
    if (fromPayload > 0) return fromPayload;
    return this.roundCurrency(this.displaySubtotal() + this.displayTax());
  });
  readonly returnCredit = computed(() => Number(this.remoteSnapshot()?.['returnCreditAmount'] || 0));
  readonly netTotal = computed(() => this.roundCurrency(Math.max(0, this.displayTotal() - this.returnCredit())));
  readonly displayPaid = computed(() => {
    const total = this.netTotal();
    const paid = Number(this.remoteSnapshot()?.['paidAmount'] ?? this.detail()?.paidAmount ?? 0);
    if (!Number.isFinite(paid) || paid <= 0) return 0;
    return this.roundCurrency(Math.min(Math.max(0, paid), Math.max(0, total)));
  });
  readonly displayDue = computed(() => {
    const due = this.remoteSnapshot()?.['amount'];
    if (due !== undefined && Number.isFinite(Number(due))) return Math.max(0, Number(due));
    return this.roundCurrency(Math.max(0, this.netTotal() - this.displayPaid()));
  });

  readonly paymentState = signal<PaymentState>('idle');
  readonly statusMessage = signal('');
  readonly invoiceLoading = signal(false);
  readonly invoiceError = signal('');
  readonly refreshedBalanceNeeded = signal(false);
  readonly gatewayPending = signal(false);
  readonly confirmedPaidAmount = signal<number | null>(null);
  readonly paymentComplete = computed(() => {
    if (this.paymentState() === 'processing') return false;
    if (this.paymentState() === 'paid') return true;
    return !!this.remoteSnapshot() && (this.displayTotal() > 0 || this.returnCredit() > 0) && this.displayDue() <= 0;
  });
  readonly paidConfirmationMessage = computed(() => {
    const customer = this.customerName();
    const business = this.businessName();
    return `Thanks ${customer}, ${business} has received your payment.`;
  });
  readonly cardholderName = signal('');
  readonly cardNumber = signal('');
  readonly expiryMonth = signal('');
  readonly expiryYear = signal('');
  readonly cardCode = signal('');
  readonly billingZip = signal('');
  readonly paylynxReady = signal(false);
  readonly paylynxError = signal('');
  private paylynxForm: PaylynxCardForm | null = null;
  private paylynxTarget: HTMLElement | undefined;
  private paylynxReadyTimer?: ReturnType<typeof setTimeout>;
  private paylynxResize?: ResizeObserver;
  private paylynxCompact = false;

  @ViewChild('paylynxCardFields')
  set paylynxCardFields(field: ElementRef<HTMLElement> | undefined) {
    this.clearPaylynxForm();
    this.paylynxTarget = field?.nativeElement;
    if (this.paylynxTarget) void this.mountPaylynxForm(this.paylynxTarget);
  }

  readonly canCheckout = computed(() => {
    if (this.gatewayPending() || this.refreshedBalanceNeeded() || this.invoiceLoading()) return false;
    if (!this.invoiceId() || !this.remoteSnapshot()) return false;
    if (Number(this.normalizedAmount()) <= 0) return false;
    if (this.isPaylynx()) return this.paylynxReady();
    if (!this.isAuthorizeNet()) return !!this.paymentUrl();
    return this.authorizeNetCardIsValid();
  });
  readonly checkoutBlockedReason = computed(() => {
    if (this.invoiceError()) return this.invoiceError();
    if (this.invoiceLoading() || this.gatewayPending() || this.refreshedBalanceNeeded()) return '';
    if (!this.invoiceId()) return 'Invoice is missing.';
    if (!this.remoteSnapshot()) return 'Open the latest payment link from the shop.';
    if (Number(this.normalizedAmount()) <= 0) return 'This invoice is already paid in full.';
    if (this.isPaylynx()) return this.paylynxError();
    if (!this.isAuthorizeNet() && !this.paymentUrl()) return 'This invoice is missing payment configuration.';
    if (this.isAuthorizeNet() && !this.authorizeNetCardIsValid()) return '';
    return '';
  });

  constructor() {
    effect(() => {
      const dark = this.theme.mode() === 'dark';
      if (this.paylynxTarget) this.paylynxForm?.setStyles(this.hostedFieldStyles(this.paylynxTarget, dark));
    });
    void this.loadRemoteSnapshot();
  }

  ngOnDestroy(): void {
    this.clearPaylynxForm();
  }

  private clearPaylynxForm(): void {
    this.paylynxTarget = undefined;
    clearTimeout(this.paylynxReadyTimer);
    this.paylynxResize?.disconnect();
    this.paylynxReady.set(false);
    this.paylynxForm?.destroy();
    this.paylynxForm = null;
  }

  private async mountPaylynxForm(target: HTMLElement): Promise<void> {
    try {
      const config = this.staffCharge ? { tokenizationKey: this.staffTokenizationKey, paymentPending: this.staffPaymentPending, mode: this.paylynxMode() }
        : await firstValueFrom(this.http.get<{ tokenizationKey: string; paymentPending?: boolean; mode?: 'test' | 'live' }>('/api/payment-charge', {
        params: this.fromCustomerPortal() ? { invoiceId: this.invoiceId() }
          : { invoiceId: this.invoiceId(), publicToken: this.publicToken() },
        headers: { 'x-tenant-id': this.tenantId(), 'x-skip-action-toast': '1',
          ...(this.fromCustomerPortal() ? { 'x-visit-token': this.publicToken() } : {}) }
      }).pipe(timeout(15_000)));
      if (this.paylynxTarget !== target) return;
      if (config.paymentPending) {
        this.showPendingPayment();
        return;
      }
      this.paylynxMode.set(config.mode === 'live' ? 'live' : 'test');
      const sdk = await loadPaylynxTokenization(this.paylynxMode());
      if (this.paylynxTarget !== target) return;
      this.paylynxForm = new sdk(config.tokenizationKey, {
        target, showZip: true, showFieldErrors: true,
        styles: this.hostedFieldStyles(target, this.theme.mode() === 'dark')
      });
      target.querySelector('iframe')?.setAttribute('title', 'PayLynx secure card details');
      this.paylynxResize = new ResizeObserver(() => {
        if (this.paylynxTarget !== target || this.paylynxCompact === (target.clientWidth < COMPACT_CARD_FIELDS_WIDTH)) return;
        this.paylynxForm?.setStyles(this.hostedFieldStyles(target, this.theme.mode() === 'dark'));
      });
      this.paylynxResize.observe(target);
      this.paylynxReadyTimer = setTimeout(() => {
        this.paylynxError.set('PayLynx secure card fields could not load. Refresh the page to try again.');
      }, 15_000);
      this.paylynxForm.on('ready', () => {
        if (this.paylynxTarget !== target) return;
        clearTimeout(this.paylynxReadyTimer);
        this.paylynxError.set('');
        this.paylynxReady.set(true);
      });
    } catch (error) {
      if (this.paylynxTarget === target) this.paylynxError.set(this.paymentErrorMessage(error));
    }
  }

  private hostedFieldStyles(target: HTMLElement, dark: boolean) {
    this.paylynxCompact = target.clientWidth < COMPACT_CARD_FIELDS_WIDTH;
    target.style.height = this.paylynxCompact ? '274px' : '183px';
    return paylynxFieldStyles(dark, this.paylynxCompact, getComputedStyle(target).backgroundColor);
  }

  retrySecureFields(): void {
    const target = this.paylynxTarget;
    if (!target || this.paymentState() === 'processing') return;
    this.clearPaylynxForm();
    this.paylynxTarget = target;
    void this.mountPaylynxForm(target);
  }

  hasPendingAction(): boolean {
    return this.paymentState() === 'processing';
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!this.hasPendingAction()) return;
    event.preventDefault();
    event.returnValue = '';
  }

  async loadRemoteSnapshot(): Promise<void> {
    const invoiceId = this.invoiceId();
    const publicToken = this.publicToken();
    const tenantId = this.tenantId();
    if (!invoiceId || (!publicToken && !this.staffCharge) || this.invoiceLoading()) return;
    this.invoiceLoading.set(true);
    this.invoiceError.set('');
    try {
      let item: Record<string, unknown> | null;
      if (this.staffCharge) {
        item = await firstValueFrom(this.http.get<Record<string, unknown>>('/api/payment-charge', {
          params: { invoiceId, staffCharge: 'true', tenantId },
          headers: { 'x-tenant-id': tenantId, 'x-skip-action-toast': '1' }
        }));
        this.staffTokenizationKey = String(item['tokenizationKey'] || '');
        this.paylynxMode.set(item['mode'] === 'live' ? 'live' : 'test');
        this.staffPaymentPending = item['paymentPending'] === true;
      } else {
        const response = await firstValueFrom(this.invoiceResponseApi.getSnapshot(invoiceId, publicToken, tenantId));
        item = response?.item && typeof response.item === 'object' ? response.item as Record<string, unknown> : null;
      }
      this.remoteSnapshot.set(item);
      this.refreshedBalanceNeeded.set(false);
      if (this.paymentState() !== 'processing') this.statusMessage.set('');
    } catch (error) {
      this.remoteSnapshot.set(null);
      this.invoiceError.set(this.paymentErrorMessage(error, 'The invoice could not load. Refresh to try again.'));
    } finally {
      this.invoiceLoading.set(false);
    }
  }

  private remoteValue(key: string): string {
    const snapshot = this.remoteSnapshot();
    return String(snapshot?.[key] || '').trim();
  }

  async checkoutAndPay(): Promise<void> {
    if (!this.canCheckout() || this.paymentState() === 'processing') return;

    this.paymentState.set('processing');
    this.statusMessage.set('Processing payment...');
    let submitted = false;

    try {
      if (this.isPaylynx() || this.isAuthorizeNet()) {
        const card = this.isPaylynx() ? await this.paylynxPaymentSource() : {
          cardholderName: this.cardholderName(),
          cardNumber: this.cardNumber(),
          expiryMonth: this.expiryMonth(),
          expiryYear: this.expiryYear(),
          cardCode: this.cardCode(),
          billingZip: this.billingZip()
        };
        submitted = true;
        const charge = await firstValueFrom(this.http.post<PaymentChargeResponse>('/api/payment-charge', {
          invoiceId: this.invoiceId(),
          tenantId: this.tenantId(),
          ...(this.staffCharge ? { staffCharge: true } : { publicToken: this.publicToken() }),
          amount: this.normalizedAmount(),
          ...card
        }, { headers: { 'x-tenant-id': this.tenantId(), 'x-skip-action-toast': '1' } }));
        if (charge?.ok !== true || !String(charge.transactionId || '').trim() ||
            (this.isPaylynx() && charge.provider !== 'paylynx')) {
          throw new Error('Payment was not confirmed by the processor.');
        }
        this.confirmedPaidAmount.set(charge.paidAmount ?? this.netTotal());
        this.paymentState.set('paid');
        this.statusMessage.set(charge.receiptSent
          ? 'Payment received. A receipt was emailed to you.'
          : 'Payment received.');
      } else {
        const paymentUrl = this.paymentUrl();
        const checkoutUrl = new URL(paymentUrl);
        if (checkoutUrl.protocol !== 'https:' || checkoutUrl.username || checkoutUrl.password) {
          throw new Error('Invalid secure checkout URL.');
        }
        window.open(checkoutUrl.href, '_blank', 'noopener,noreferrer');
        // A checkout handoff is not proof of payment (including a blocked popup).
        this.paymentState.set('awaiting-confirmation');
        this.statusMessage.set('Complete payment with the payment provider. Payment is not yet confirmed here. If checkout did not open, allow popups and try again.');
        return;
      }
    } catch (err: unknown) {
      const failure = err as { status?: number; error?: { code?: string } };
      const code = failure?.error?.code;
      const pending = code === 'payment_pending' || (submitted && (failure?.status === 0 || failure?.status === undefined));
      this.refreshedBalanceNeeded.set(code === 'balance_changed');
      if (pending) this.showPendingPayment();
      else {
        this.paymentState.set('error');
        this.statusMessage.set(this.paymentErrorMessage(err, 'We could not complete the payment. Try again or contact the shop.'));
      }
      if (code === 'card_token') this.retrySecureFields();
    } finally {
      this.cardNumber.set('');
      this.cardCode.set('');
    }
  }

  private showPendingPayment(): void {
    this.gatewayPending.set(true);
    this.paymentState.set('awaiting-confirmation');
    this.statusMessage.set(this.staffCharge ? 'Payment is awaiting confirmation. Check PayLynx before charging again.'
      : 'Payment is awaiting confirmation. Contact the shop before trying again.');
  }

  private async paylynxPaymentSource() {
    try {
      if (!this.paylynxForm) throw new Error();
      const card = await firstValueFrom(from(this.paylynxForm.getNonceToken()).pipe(timeout(15_000)));
      if (!card.nonce) throw new Error();
      return {
        source: `nonce-${card.nonce}`,
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
        billingZip: card.avsZip
      };
    } catch {
      throw new Error('Check the PayLynx card fields and try again.');
    }
  }

  private paymentErrorMessage(err: any, fallback = 'PayLynx secure card fields could not load.'): string {
    const error = String(err?.error?.error || '').trim();
    if (error) return error;
    if (err instanceof Error && !('status' in err)) return err.message || fallback;
    return fallback;
  }

  private normalizedAmount(): string {
    const dueFromDetail = this.displayDue();
    if (!this.remoteSnapshot() && dueFromDetail > 0) return dueFromDetail.toFixed(2);
    const value = String(this.amount() || '').replace(/[^0-9.\-]/g, '');
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return '0.00';
    return parsed.toFixed(2);
  }

  money(value: number): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
  }

  private roundCurrency(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private toAddressLines(value: string): string[] {
    const source = String(value || '').trim();
    if (!source) return [];
    return source
      .split(/\n|,/g)
      .map(part => part.trim())
      .filter(Boolean);
  }

  private authorizeNetCardIsValid(): boolean {
    const card = String(this.cardNumber() || '').replace(/\D+/g, '');
    const code = String(this.cardCode() || '').replace(/\D+/g, '');
    const month = Number(String(this.expiryMonth() || '').replace(/\D+/g, ''));
    const yearRaw = String(this.expiryYear() || '').replace(/\D+/g, '');
    const year = Number(yearRaw.length === 2 ? `20${yearRaw}` : yearRaw);
    if (card.length < 13 || card.length > 19) return false;
    if (code.length < 3 || code.length > 4) return false;
    if (!Number.isFinite(month) || month < 1 || month > 12) return false;
    if (!Number.isFinite(year) || year < 2000) return false;
    return true;
  }

  private decodeInvoicePayload(raw: string | null): InvoicePaymentPayload | null {
    const value = String(raw || '').trim();
    if (!value) return null;
    try {
      const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
      const json = typeof atob === 'function' ? atob(padded) : '';
      const decoded = typeof TextDecoder !== 'undefined'
        ? new TextDecoder().decode(Uint8Array.from(json, char => char.charCodeAt(0)))
        : json;
      const parsed = JSON.parse(decoded || '{}') as InvoicePaymentPayload;
      return this.normalizeInvoicePayload(parsed);
    } catch {
      return null;
    }
  }

  private normalizeInvoicePayload(value: unknown): InvoicePaymentPayload | null {
    const parsed = value && typeof value === 'object' ? value as InvoicePaymentPayload : null;
    if (!parsed) return null;
    const lineItems = Array.isArray(parsed.lineItems)
      ? parsed.lineItems.map((line, index) => this.normalizePayloadLineItem(line, index))
      : [];
    return {
      jobNumber: String(parsed.jobNumber || '').trim(),
      customerId: String(parsed.customerId || '').trim(),
      subtotal: this.roundCurrency(Math.max(0, Number(parsed.subtotal || 0))),
      taxTotal: this.roundCurrency(Math.max(0, Number(parsed.taxTotal || 0))),
      total: this.roundCurrency(Math.max(0, Number(parsed.total || 0))),
      lineItems
    };
  }

  private normalizePayloadLineItem(line: Partial<InvoiceLineItem>, index: number): InvoiceLineItem {
    const quantity = Math.max(0, Number(line?.quantity || 0));
    const unitPrice = this.roundCurrency(Math.max(0, Number(line?.unitPrice || 0)));
    const taxRate = this.roundCurrency(Math.max(0, Number(line?.taxRate || 0)));
    const lineSubtotal = this.roundCurrency(Math.max(0, Number(line?.lineSubtotal || quantity * unitPrice)));
    const taxAmount = this.roundCurrency(Math.max(0, Number(line?.taxAmount || (lineSubtotal * taxRate) / 100)));
    const lineTotal = this.roundCurrency(Math.max(0, Number(line?.lineTotal || lineSubtotal + taxAmount)));
    const type = String(line?.type || '').trim().toLowerCase() === 'labor' ? 'labor' : 'part';
    return {
      id: String(line?.id || `payment-line-${index}`).trim(),
      type,
      jobPartId: type === 'part' ? String(line?.jobPartId || '').trim() : '',
      relatedInventoryItemId: type === 'part' ? String(line?.relatedInventoryItemId || '').trim() : '',
      partStatus: type === 'part' ? line?.partStatus : undefined,
      trackingNumber: type === 'part' ? String(line?.trackingNumber || '').trim() : '',
      code: String(line?.code || '').trim(),
      description: String(line?.description || '').trim(),
      quantity,
      unitPrice,
      taxRate,
      lineSubtotal,
      taxAmount,
      lineTotal
    };
  }
}
