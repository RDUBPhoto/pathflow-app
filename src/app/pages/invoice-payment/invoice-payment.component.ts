import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { ActivatedRoute } from '@angular/router';
import { IonContent } from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { InvoiceResponseApiService } from '../../services/invoice-response-api.service';
import { InvoiceLineItem, InvoicesDataService } from '../../services/invoices-data.service';
import { EmailApiService } from '../../services/email-api.service';
import { environment } from '../../../environments/environment';

type PaymentState = 'idle' | 'processing' | 'paid' | 'error';
const LOCAL_PENDING_INVOICE_RESPONSES_KEY = 'pathflow.invoiceResponses.pending.v1';

type PendingInvoiceResponse = {
  invoiceId: string;
  stage: 'accepted';
  tenantId: string;
  updatedAt: string;
};

@Component({
  selector: 'app-invoice-payment',
  standalone: true,
  imports: [CommonModule, FormsModule, IonContent],
  templateUrl: './invoice-payment.component.html',
  styleUrls: ['./invoice-payment.component.scss']
})
export default class InvoicePaymentComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);
  private readonly invoiceResponseApi = inject(InvoiceResponseApiService);
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly emailApi = inject(EmailApiService);

  readonly invoiceId = computed(() => String(this.route.snapshot.queryParamMap.get('invoiceId') || '').trim());
  readonly tenantId = computed(() => String(this.route.snapshot.queryParamMap.get('tenantId') || '').trim().toLowerCase() || 'main');
  readonly invoiceNumber = computed(() => String(this.route.snapshot.queryParamMap.get('invoiceNumber') || '').trim() || 'Invoice');
  readonly customerName = computed(() => String(this.route.snapshot.queryParamMap.get('customerName') || '').trim() || 'Customer');
  readonly customerEmail = computed(() => String(this.route.snapshot.queryParamMap.get('customerEmail') || this.detail()?.customerEmail || '').trim());
  readonly vehicle = computed(() => String(this.route.snapshot.queryParamMap.get('vehicle') || '').trim() || 'Vehicle details pending');
  readonly businessName = computed(() => String(this.route.snapshot.queryParamMap.get('businessName') || '').trim() || 'Our team');
  readonly amount = computed(() => String(this.route.snapshot.queryParamMap.get('amount') || '').trim() || '');
  readonly dueDate = computed(() => String(this.route.snapshot.queryParamMap.get('dueDate') || '').trim() || '');
  readonly paymentUrl = computed(() => String(this.route.snapshot.queryParamMap.get('paymentUrl') || '').trim());
  readonly paymentProvider = computed(() => String(this.route.snapshot.queryParamMap.get('paymentProvider') || '').trim().toLowerCase());
  readonly isAuthorizeNet = computed(() => this.paymentProvider() === 'authorize-net' || this.paymentUrl().includes('/authorize-net/'));
  readonly detail = computed(() => this.invoicesData.getInvoiceById(this.invoiceId()));
  readonly businessLogoUrl = computed(() => String(this.detail()?.businessLogoUrl || '').trim());
  readonly businessAddressLines = computed(() => this.toAddressLines(String(this.detail()?.businessAddress || this.businessName())));
  readonly customerAddressLines = computed(() => this.toAddressLines(String(this.detail()?.customerAddress || '')));
  readonly lineItems = computed<InvoiceLineItem[]>(() => this.detail()?.lineItems || []);
  readonly displaySubtotal = computed(() => {
    const fromDetail = Number(this.detail()?.subtotal || 0);
    if (fromDetail > 0) return fromDetail;
    return this.roundCurrency(this.lineItems().reduce((sum, item) => sum + Number(item.lineSubtotal || 0), 0));
  });
  readonly displayTax = computed(() => {
    const fromDetail = Number(this.detail()?.taxTotal || 0);
    if (fromDetail > 0) return fromDetail;
    return this.roundCurrency(this.lineItems().reduce((sum, item) => sum + Number(item.taxAmount || 0), 0));
  });
  readonly displayTotal = computed(() => {
    const fromDetail = Number(this.detail()?.total || 0);
    if (fromDetail > 0) return fromDetail;
    return this.roundCurrency(this.displaySubtotal() + this.displayTax());
  });
  readonly displayPaid = computed(() => {
    const total = this.displayTotal();
    const paid = Number(this.detail()?.paidAmount || 0);
    if (!Number.isFinite(paid) || paid <= 0) return 0;
    return this.roundCurrency(Math.min(Math.max(0, paid), Math.max(0, total)));
  });
  readonly displayDue = computed(() => this.roundCurrency(Math.max(0, this.displayTotal() - this.displayPaid())));

  readonly paymentState = signal<PaymentState>('idle');
  readonly statusMessage = signal('');
  readonly cardholderName = signal('');
  readonly cardNumber = signal('');
  readonly expiryMonth = signal('');
  readonly expiryYear = signal('');
  readonly cardCode = signal('');
  readonly billingZip = signal('');

  readonly canCheckout = computed(() => {
    if (!this.invoiceId()) return false;
    if (Number(this.normalizedAmount()) <= 0) return false;
    if (!this.isAuthorizeNet()) return !!this.paymentUrl();
    return this.authorizeNetCardIsValid();
  });
  readonly checkoutBlockedReason = computed(() => {
    if (!this.invoiceId()) return 'Invoice is missing.';
    if (Number(this.normalizedAmount()) <= 0) return 'This invoice is already paid in full.';
    if (!this.isAuthorizeNet() && !this.paymentUrl()) return 'This invoice is missing payment configuration.';
    if (this.isAuthorizeNet() && !this.authorizeNetCardIsValid()) return '';
    return '';
  });

  async checkoutAndPay(): Promise<void> {
    if (!this.canCheckout() || this.paymentState() === 'processing') return;

    this.paymentState.set('processing');
    this.statusMessage.set('Processing payment...');

    let chargeApproved = false;
    try {
      if (this.isAuthorizeNet()) {
        await firstValueFrom(this.http.post('/api/payment-charge', {
          invoiceId: this.invoiceId(),
          tenantId: this.tenantId(),
          invoiceNumber: this.invoiceNumber(),
          customerName: this.customerName(),
          amount: this.normalizedAmount(),
          cardholderName: this.cardholderName(),
          cardNumber: this.cardNumber(),
          expiryMonth: this.expiryMonth(),
          expiryYear: this.expiryYear(),
          cardCode: this.cardCode(),
          billingZip: this.billingZip()
        }));
      } else {
        const paymentUrl = this.paymentUrl();
        if (paymentUrl) {
          window.open(paymentUrl, '_blank', 'noopener,noreferrer');
        }
      }
      chargeApproved = true;
    } catch (err: any) {
      this.paymentState.set('error');
      this.statusMessage.set(this.paymentErrorMessage(err));
      return;
    }

    const paymentResult = this.markInvoicePaidLocally();
    const fullPayment = paymentResult.settled;

    if (fullPayment) {
      this.persistPendingResponse({
        invoiceId: this.invoiceId(),
        stage: 'accepted',
        tenantId: this.tenantId(),
        updatedAt: new Date().toISOString()
      });
    }

    const receiptSent = await this.sendReceiptEmail();

    try {
      if (fullPayment) {
        await firstValueFrom(this.invoiceResponseApi.capture({
          invoiceId: this.invoiceId(),
          action: 'pay',
          tenantId: this.tenantId(),
          invoiceNumber: this.invoiceNumber(),
          customerName: this.customerName(),
          vehicle: this.vehicle(),
          businessName: this.businessName(),
          paymentKind: this.displayPaid() > 0 ? 'final' : 'initial'
        }));
      }

      this.paymentState.set('paid');
      this.statusMessage.set(
        fullPayment
          ? (receiptSent
            ? 'Payment received. Your invoice has been marked as paid. A receipt was emailed to you.'
            : 'Payment received. Your invoice has been marked as paid.')
          : (receiptSent
            ? 'Payment received and applied to your balance. A receipt was emailed to you.'
            : 'Payment received and applied to your balance.')
      );
    } catch (err: any) {
      if (chargeApproved) {
        this.paymentState.set('paid');
        const syncMessage = [
          String(err?.error?.error || '').trim(),
          String(err?.error?.detail || '').trim(),
          String(err?.message || '').trim()
        ].find(value => !!value);
        this.statusMessage.set(
          syncMessage
            ? `Payment approved. Invoice status sync failed: ${syncMessage}${receiptSent ? ' Receipt email sent.' : ''}`
            : `Payment approved. Invoice status sync failed, but your receipt confirms payment.${receiptSent ? ' Receipt email sent.' : ''}`
        );
        return;
      }
      this.paymentState.set('error');
      this.statusMessage.set(this.paymentErrorMessage(err));
    }
  }

  private paymentErrorMessage(err: any): string {
    const error = String(err?.error?.error || '').trim();
    const detail = String(err?.error?.detail || '').trim();
    const fallback = String(err?.message || '').trim();
    if (error && detail) return `${error} (${detail})`;
    if (error) return error;
    if (detail) return detail;
    if (fallback) return fallback;
    return 'We could not confirm payment yet. Please retry or contact the shop.';
  }

  private markInvoicePaidLocally(): { settled: boolean } {
    const id = this.invoiceId();
    const detail = this.detail() || (this.invoiceNumber() ? this.invoicesData.getInvoiceById(this.invoiceNumber()) : null);
    const targetId = String(detail?.id || id || '').trim();
    if (!targetId) return { settled: false };
    const currentPaid = Number(detail?.paidAmount || 0);
    const chargeAmount = Number(this.normalizedAmount());
    const nextPaid = this.roundCurrency(Math.max(0, currentPaid) + (Number.isFinite(chargeAmount) ? Math.max(0, chargeAmount) : 0));
    const updated = this.invoicesData.setPaidAmount(
      targetId,
      nextPaid,
      `Customer paid ${this.money(chargeAmount)} from public payment link.`,
      'customer'
    );
    const resolved = updated || this.invoicesData.getInvoiceById(targetId) || detail;
    const total = this.roundCurrency(Math.max(0, Number(resolved?.total || 0)));
    const paid = this.roundCurrency(Math.max(0, Number(resolved?.paidAmount || nextPaid)));
    const due = this.roundCurrency(Math.max(0, total - paid));
    return { settled: due <= 0 };
  }

  private paymentWillSettleInvoice(): boolean {
    const chargeAmount = Number(this.normalizedAmount());
    if (!Number.isFinite(chargeAmount) || chargeAmount <= 0) return false;
    const total = this.displayTotal();
    const paid = this.displayPaid();
    const nextDue = this.roundCurrency(Math.max(0, total - (paid + chargeAmount)));
    return nextDue <= 0;
  }

  private normalizedAmount(): string {
    const dueFromDetail = this.displayDue();
    if (dueFromDetail > 0) return dueFromDetail.toFixed(2);
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

  private persistPendingResponse(entry: PendingInvoiceResponse): void {
    try {
      const raw = localStorage.getItem(LOCAL_PENDING_INVOICE_RESPONSES_KEY);
      const parsed = raw ? (JSON.parse(raw) as PendingInvoiceResponse[]) : [];
      const source = Array.isArray(parsed) ? parsed : [];
      const dedupe = `${entry.tenantId}|${entry.invoiceId}`.toLowerCase();
      const next = source.filter(item => {
        const tenantId = String(item?.tenantId || '').trim().toLowerCase();
        const invoiceId = String(item?.invoiceId || '').trim().toLowerCase();
        return `${tenantId}|${invoiceId}` !== dedupe;
      });
      next.push(entry);
      localStorage.setItem(LOCAL_PENDING_INVOICE_RESPONSES_KEY, JSON.stringify(next));
    } catch {
      // localStorage may be unavailable.
    }
  }

  private async sendReceiptEmail(): Promise<boolean> {
    const to = this.customerEmail();
    if (!to) return false;

    const subject = `Payment receipt for ${this.invoiceNumber()}`;
    const amountText = this.money(Number(this.normalizedAmount()));
    const invoiceNumber = this.invoiceNumber();
    const detail = this.detail();
    const business = detail?.businessName || this.businessName() || 'Your service team';
    const customer = this.customerName() || 'Customer';
    const paidDate = this.displayPaidDate();
    const plain = `Hi ${customer}, we received your payment for invoice ${invoiceNumber} on ${paidDate}. Amount paid: ${amountText}. Thank you, ${business}.`;
    const html = this.buildPaidReceiptEmailHtml();

    try {
      await firstValueFrom(this.emailApi.sendToCustomer({
        tenantId: this.tenantId(),
        customerId: String(detail?.customerId || this.invoiceId() || '').trim(),
        customerName: customer,
        to,
        subject,
        message: plain,
        html
      }));
      return true;
    } catch {
      return false;
    }
  }

  private escapeHtml(value: string): string {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private buildPaidReceiptEmailHtml(): string {
    const detail = this.detail();
    const business = String(detail?.businessName || this.businessName() || 'Your service team').trim();
    const customer = String(detail?.customerName || this.customerName() || 'Customer').trim();
    const invoiceNumber = String(detail?.invoiceNumber || this.invoiceNumber() || 'Invoice').trim();
    const paidDate = this.displayPaidDate();
    const logoUrl = this.resolveEmailLogoUrl(String(detail?.businessLogoUrl || '').trim());
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const paymentAmount = Number(this.normalizedAmount());
    const lineItems = detail?.lineItems || this.lineItems();
    const subtotal = Number(detail?.subtotal || this.displaySubtotal());
    const taxTotal = Number(detail?.taxTotal || this.displayTax());
    const total = Number(detail?.total || this.displayTotal());
    const paidToDate = Number(detail?.paidAmount || 0);
    const due = Math.max(0, total - paidToDate);
    const fullyPaid = this.roundCurrency(due) <= 0;
    const badgeLabel = fullyPaid ? 'PAID' : 'PAYMENT RECEIVED';
    const badgeBg = fullyPaid ? '#16a34a' : '#0ea5e9';
    const totalLabel = fullyPaid ? 'Total Paid' : 'Amount Paid';

    const itemRows = lineItems
      .map(item => `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#111827;">${this.escapeHtml(item.type === 'labor' ? 'Labor' : 'Part')}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#111827;">${this.escapeHtml(item.description || '')}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#111827;text-align:right;">${this.escapeHtml(String(item.quantity || 0))}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#111827;text-align:right;">${this.escapeHtml(money.format(Number(item.unitPrice || 0)))}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;color:#111827;text-align:right;">${this.escapeHtml(money.format(Number(item.lineTotal || 0)))}</td>
        </tr>
      `)
      .join('');

    return `
      <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.45;color:#111827;max-width:920px;margin:0 auto;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
          <tr>
            <td style="vertical-align:top;">
              ${logoUrl ? `<img src="${this.escapeHtml(logoUrl)}" alt="${this.escapeHtml(business)} logo" style="max-height:72px;max-width:220px;display:block;margin:0 0 8px 0;">` : ''}
              <div style="font-size:22px;font-weight:800;color:#111827;">${this.escapeHtml(business)}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail?.businessAddress || '').trim())}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail?.businessPhone || '').trim())}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail?.businessEmail || '').trim())}</div>
            </td>
            <td style="vertical-align:top;text-align:right;">
              <div style="font-size:30px;font-weight:800;letter-spacing:.08em;color:#111827;">RECEIPT</div>
              <div style="color:#111827;"><strong>Invoice #:</strong> ${this.escapeHtml(invoiceNumber)}</div>
              <div style="color:#111827;"><strong>Paid Date:</strong> ${this.escapeHtml(paidDate)}</div>
              <div style="margin-top:6px;display:inline-block;background:${badgeBg};color:#fff;padding:5px 10px;border-radius:999px;font-size:12px;font-weight:700;">${badgeLabel}</div>
            </td>
          </tr>
        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
          <tr>
            <td style="vertical-align:top;">
              <div style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;">Bill To</div>
              <div style="font-size:18px;font-weight:700;color:#111827;">${this.escapeHtml(customer)}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail?.customerAddress || '').trim())}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail?.customerPhone || '').trim())}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail?.customerEmail || this.customerEmail() || '').trim())}</div>
              <div style="color:#334155;"><strong>Vehicle:</strong> ${this.escapeHtml(String(detail?.vehicle || this.vehicle() || 'Vehicle details pending').trim())}</div>
            </td>
          </tr>
        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:10px 0 14px;">
          <thead>
            <tr>
              <th style="background:#e5e7eb;text-align:left;padding:8px;color:#111827;">Item</th>
              <th style="background:#e5e7eb;text-align:left;padding:8px;color:#111827;">Description</th>
              <th style="background:#e5e7eb;text-align:right;padding:8px;color:#111827;">Qty</th>
              <th style="background:#e5e7eb;text-align:right;padding:8px;color:#111827;">Price</th>
              <th style="background:#e5e7eb;text-align:right;padding:8px;color:#111827;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${itemRows || '<tr><td colspan="5" style="padding:8px;border-bottom:1px solid #e5e7eb;color:#64748b;">No line items.</td></tr>'}
          </tbody>
        </table>

        <table role="presentation" align="right" cellpadding="0" cellspacing="0" border="0" style="width:340px;max-width:100%;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;">
          <tr>
            <td style="padding:8px;color:#111827;">Subtotal:</td>
            <td style="padding:8px;text-align:right;font-weight:700;color:#111827;">${this.escapeHtml(money.format(subtotal))}</td>
          </tr>
          <tr>
            <td style="padding:8px;color:#111827;">Tax:</td>
            <td style="padding:8px;text-align:right;font-weight:700;color:#111827;">${this.escapeHtml(money.format(taxTotal))}</td>
          </tr>
          <tr>
            <td style="padding:10px;background:#dcfce7;font-weight:800;color:#111827;">${totalLabel}:</td>
            <td style="padding:10px;background:#dcfce7;text-align:right;font-weight:800;color:#111827;">${this.escapeHtml(money.format(Math.max(0, paymentAmount)))}</td>
          </tr>
          <tr>
            <td style="padding:8px;color:#111827;">Invoice Total:</td>
            <td style="padding:8px;text-align:right;font-weight:700;color:#111827;">${this.escapeHtml(money.format(total))}</td>
          </tr>
          <tr>
            <td style="padding:8px;color:#111827;">Paid To Date:</td>
            <td style="padding:8px;text-align:right;font-weight:700;color:#111827;">${this.escapeHtml(money.format(Math.max(0, paidToDate)))}</td>
          </tr>
          <tr>
            <td style="padding:8px;color:#111827;">Balance Due:</td>
            <td style="padding:8px;text-align:right;font-weight:700;color:#111827;">${this.escapeHtml(money.format(Math.max(0, due)))}</td>
          </tr>
        </table>
        <div style="clear:both"></div>

        <p style="margin-top:16px;color:#334155;">Thank you for your payment.</p>
      </div>
    `;
  }

  private displayPaidDate(): string {
    const source = String(this.detail()?.paymentDate || this.detail()?.updatedAt || '').trim();
    if (!source) return new Date().toLocaleDateString('en-US');
    const parsed = new Date(source);
    if (!Number.isFinite(parsed.getTime())) return source;
    return parsed.toLocaleDateString('en-US');
  }

  private resolveEmailLogoUrl(value: string): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    const base = this.publicAppBaseUrl();
    if (!base) return raw;
    if (raw.startsWith('/')) return `${base}${raw}`;
    return `${base}/${raw}`;
  }

  private publicAppBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location?.hostname) {
      const host = String(window.location.hostname || '').trim().toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
        return String(window.location.origin).trim().replace(/\/+$/, '');
      }
    }
    const configured = String(environment.publicAppUrl || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    if (typeof window !== 'undefined' && window.location?.origin) {
      return String(window.location.origin).trim().replace(/\/+$/, '');
    }
    return '';
  }
}
