import { CommonModule, CurrencyPipe, DatePipe } from '@angular/common';
import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ToastController } from '@ionic/angular';
import { IonButton, IonButtons, IonContent, IonHeader, IonModal, IonTitle, IonToolbar } from '@ionic/angular/standalone';
import { Subscription, finalize, firstValueFrom } from 'rxjs';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  mailOpenOutline,
  documentOutline,
  checkmarkOutline,
  closeOutline,
  pauseOutline,
  alertCircleOutline
} from 'ionicons/icons';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import {
  InvoiceBoardStage,
  InvoiceDetail,
  InvoiceDocumentType,
  InvoiceLineItem,
  InvoicePartStatus,
  InvoicePaymentTransaction,
  InvoiceRefundTransaction,
  InvoiceLineType,
  InvoiceStage,
  InvoiceTimelineEntry,
  InvoicesDataService
} from '../../services/invoices-data.service';
import { Lane, LanesApi } from '../../services/lanes-api.service';
import { PaymentGatewaySettingsService } from '../../services/payment-gateway-settings.service';
import { WorkItem, WorkItemsApi } from '../../services/workitems-api.service';
import { AddressLookupService, AddressSuggestion } from '../../services/address-lookup.service';
import { AuthService } from '../../auth/auth.service';
import { NotificationsApiService } from '../../services/notifications-api.service';
import { EmailApiService } from '../../services/email-api.service';
import { SmsApiService } from '../../services/sms-api.service';
import { TenantContextService } from '../../services/tenant-context.service';
import { PaymentRefundApiService, PaymentRefundResponse } from '../../services/payment-refund-api.service';
import { environment } from '../../../environments/environment';

type StatusTone = 'neutral' | 'success' | 'error';
type RefundAllocation = {
  provider: string;
  originalTransactionId: string;
  accountNumber: string;
  refundableAmount: number;
};

@Component({
  selector: 'app-invoice-detail',
  standalone: true,
  imports: [
    CommonModule,
    CurrencyPipe,
    DatePipe,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonModal,
    IonIcon,
    IonContent,
    PageBackButtonComponent,
    CompanySwitcherComponent,
    UserMenuComponent
  ],
  templateUrl: './invoice-detail.component.html',
  styleUrls: ['./invoice-detail.component.scss']
})
export default class InvoiceDetailComponent implements OnDestroy {
  readonly lineItemsPageSize = 10;
  private readonly quoteStageOptionsList: InvoiceBoardStage[] = ['draft', 'sent', 'accepted', 'declined'];
  private readonly invoiceStageOptionsList: InvoiceBoardStage[] = ['draft', 'sent', 'accepted', 'completed'];
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly paymentSettings = inject(PaymentGatewaySettingsService);
  private readonly lanesApi = inject(LanesApi);
  private readonly workItemsApi = inject(WorkItemsApi);
  private readonly addressLookup = inject(AddressLookupService);
  private readonly notificationsApi = inject(NotificationsApiService);
  private readonly auth = inject(AuthService);
  private readonly emailApi = inject(EmailApiService);
  private readonly smsApi = inject(SmsApiService);
  private readonly tenantContext = inject(TenantContextService);
  private readonly paymentRefundApi = inject(PaymentRefundApiService);
  private readonly toastController = inject(ToastController);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly status = signal('');
  readonly statusTone = signal<StatusTone>('neutral');
  readonly lineItemsPage = signal(1);
  readonly sendingInvoice = signal(false);
  readonly refundingCustomer = signal(false);
  readonly sendInvoiceModalOpen = signal(false);
  readonly sendInvoiceModalError = signal('');
  readonly sendInvoiceViaEmail = signal(true);
  readonly sendInvoiceViaSms = signal(false);
  readonly emailingPaidReceipt = signal(false);
  readonly textingPaidReceipt = signal(false);
  readonly customerAddressSuggestions = signal<AddressSuggestion[]>([]);
  readonly customerAddressSearching = signal(false);
  readonly customerAddressNoMatches = signal(false);
  readonly businessAddressSuggestions = signal<AddressSuggestion[]>([]);
  readonly businessAddressSearching = signal(false);
  readonly businessAddressNoMatches = signal(false);
  private customerAddressLookupSub: Subscription | null = null;
  private businessAddressLookupSub: Subscription | null = null;
  private customerAddressSearchTimer: ReturnType<typeof setTimeout> | null = null;
  private businessAddressSearchTimer: ReturnType<typeof setTimeout> | null = null;
  private lastToastKey = '';
  private lastToastAt = 0;
  private pendingOpenSendModal = false;
  private pendingSendNow = false;
  private autoOpenSendModalTimer: ReturnType<typeof setTimeout> | null = null;
  private autoSendNowTimer: ReturnType<typeof setTimeout> | null = null;

  readonly invoice = signal<InvoiceDetail | null>(null);
  private readonly baselineSnapshot = signal('');
  readonly partStatusOptions: Array<{ value: InvoicePartStatus; label: string }> = [
    { value: 'in-stock', label: 'In-stock' },
    { value: 'ordered', label: 'Ordered' },
    { value: 'backordered', label: 'Backordered' },
    { value: 'received', label: 'Received' }
  ];

  readonly paymentAvailability = this.paymentSettings.paymentLinkAvailability;
  readonly documentTypeLabel = computed(() => this.documentTypeLabelFor(this.invoice()?.documentType || 'invoice'));
  readonly invoiceEmailTarget = computed(() => String(this.invoice()?.customerEmail || '').trim());
  readonly invoiceSmsTarget = computed(() => String(this.invoice()?.customerPhone || '').trim());
  readonly canSendInvoiceViaEmail = computed(() => !!this.invoiceEmailTarget());
  readonly canSendInvoiceViaSms = computed(() => !!this.invoiceSmsTarget());
  readonly canConfirmSendInvoice = computed(() =>
    (this.sendInvoiceViaEmail() && this.canSendInvoiceViaEmail())
    || (this.sendInvoiceViaSms() && this.canSendInvoiceViaSms())
  );

  readonly totals = computed(() => {
    const detail = this.invoice();
    const lineItems = detail?.lineItems || [];
    const subtotal = this.roundCurrency(lineItems.reduce((sum, line) => sum + line.lineSubtotal, 0));
    const taxTotal = this.roundCurrency(lineItems.reduce((sum, line) => sum + line.taxAmount, 0));
    const total = this.roundCurrency(subtotal + taxTotal);
    return { subtotal, taxTotal, total };
  });
  readonly paidAmount = computed(() => {
    return this.normalizePaidAmount(this.invoice()?.paidAmount);
  });
  readonly amountDue = computed(() => this.roundCurrency(Math.max(0, this.totals().total - this.paidAmount())));
  readonly overpaymentAmount = computed(() => this.roundCurrency(Math.max(0, this.paidAmount() - this.totals().total)));
  readonly sendInvoiceLabel = computed(() => {
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice') return 'Send Invoice';
    if (detail.stage === 'completed') return 'Completed';
    if (this.paidAmount() > 0) {
      return this.isFinalInvoiceSendLocked(detail) ? 'Final invoice sent' : 'Send Final Invoice';
    }
    return 'Send Invoice';
  });
  readonly isFinalInvoiceMode = computed(() => {
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice') return false;
    if (detail.stage === 'draft') return false;
    return this.paidAmount() > 0;
  });
  readonly isFinalInvoiceSendDisabled = computed(() => {
    const detail = this.invoice();
    if (!detail) return false;
    if (detail.stage === 'completed') return true;
    return this.isFinalInvoiceSendLocked(detail);
  });

  readonly hasChanges = computed(() => {
    const current = this.invoice();
    if (!current) return false;
    return this.snapshot(current) !== this.baselineSnapshot();
  });

  readonly canSave = computed(() => !!this.invoice() && this.hasChanges() && !this.saving());
  readonly lineItems = computed(() => this.invoice()?.lineItems || []);
  readonly lineItemsTotalPages = computed(() => Math.max(1, Math.ceil(this.lineItems().length / this.lineItemsPageSize)));
  readonly pagedLineItems = computed(() => {
    const page = Math.max(1, Math.min(this.lineItemsPage(), this.lineItemsTotalPages()));
    const start = (page - 1) * this.lineItemsPageSize;
    return this.lineItems().slice(start, start + this.lineItemsPageSize);
  });

  constructor() {
    addIcons({
      'mail-open-outline': mailOpenOutline,
      'document-outline': documentOutline,
      'checkmark-outline': checkmarkOutline,
      'close-outline': closeOutline,
      'pause-outline': pauseOutline,
      'alert-circle-outline': alertCircleOutline
    });

    this.route.paramMap.subscribe(params => {
      const id = String(params.get('id') || '').trim();
      this.loadInvoice(id);
    });
    this.route.queryParamMap.subscribe(params => {
      const raw = String(params.get('openSendModal') || '').trim().toLowerCase();
      this.pendingOpenSendModal = raw === '1' || raw === 'true' || raw === 'yes';
      if (this.pendingOpenSendModal) this.scheduleAutoOpenSendModal();
      const sendNowRaw = String(params.get('sendNow') || '').trim().toLowerCase();
      this.pendingSendNow = sendNowRaw === '1' || sendNowRaw === 'true' || sendNowRaw === 'yes';
      if (this.pendingSendNow) this.scheduleAutoSendNow();
    });
  }

  ngOnDestroy(): void {
    this.customerAddressLookupSub?.unsubscribe();
    this.businessAddressLookupSub?.unsubscribe();
    if (this.customerAddressSearchTimer) {
      clearTimeout(this.customerAddressSearchTimer);
      this.customerAddressSearchTimer = null;
    }
    if (this.businessAddressSearchTimer) {
      clearTimeout(this.businessAddressSearchTimer);
      this.businessAddressSearchTimer = null;
    }
    if (this.autoOpenSendModalTimer) {
      clearTimeout(this.autoOpenSendModalTimer);
      this.autoOpenSendModalTimer = null;
    }
    if (this.autoSendNowTimer) {
      clearTimeout(this.autoSendNowTimer);
      this.autoSendNowTimer = null;
    }
  }

  async setStage(value: string): Promise<void> {
    if (!this.isStage(value)) return;
    const current = this.invoice();
    if (current?.documentType === 'invoice' && (value === 'accepted' || value === 'completed')) {
      const fullAmount = this.totals().total;
      this.invoice.set({
        ...current,
        stage: value,
        paidAmount: fullAmount,
        paymentDate: String(current.paymentDate || current.issueDate || '').trim() || new Date().toISOString().slice(0, 10),
        updatedAt: new Date().toISOString()
      });
      this.clearStatus();
      return;
    }
    if (current && current.stage === 'draft' && value === 'sent') {
      const wantsEmail = !!String(current.customerEmail || '').trim();
      const wantsSms = !!String(current.customerPhone || '').trim();
      if (current.documentType === 'invoice') {
        await this.sendInvoiceForPayment({ email: wantsEmail, sms: wantsSms });
      } else {
        await this.sendQuoteNow({ email: wantsEmail, sms: wantsSms });
      }
      return;
    }
    this.updateField('stage', value);
  }

  stageDisplayLabel(stage: InvoiceBoardStage): string {
    const type = this.invoice()?.documentType || 'invoice';
    if (type === 'invoice') {
      if (stage === 'draft') return 'Drafts';
      if (stage === 'accepted') return 'Paid';
      if (stage === 'completed') return 'Completed';
    }
    return stage.charAt(0).toUpperCase() + stage.slice(1);
  }

  stageOptions(): InvoiceBoardStage[] {
    const type = this.invoice()?.documentType || 'invoice';
    const base = type === 'quote' ? this.quoteStageOptionsList : this.invoiceStageOptionsList;
    const selected = this.selectedStageValue();
    return base.includes(selected) ? base : [...base, selected];
  }

  selectedStageValue(): InvoiceBoardStage {
    return this.normalizeBoardStage(this.invoice()?.stage);
  }

  updateField<K extends keyof InvoiceDetail>(field: K, value: InvoiceDetail[K]): void {
    this.invoice.update(current => {
      if (!current) return current;
      return {
        ...current,
        [field]: value,
        updatedAt: new Date().toISOString()
      };
    });
    this.clearStatus();
  }

  onCustomerAddressInput(value: string): void {
    this.updateField('customerAddress', value);
    this.customerAddressNoMatches.set(false);
    this.queueCustomerAddressLookup(value);
  }

  onCustomerAddressBlur(): void {
    const normalized = String(this.invoice()?.customerAddress || '').trim().toLowerCase();
    if (normalized) {
      const exact = this.customerAddressSuggestions().find(item => item.display.trim().toLowerCase() === normalized);
      if (exact) this.selectCustomerAddressSuggestion(exact);
    }
    setTimeout(() => this.customerAddressSuggestions.set([]), 120);
  }

  selectCustomerAddressSuggestion(item: AddressSuggestion): void {
    this.updateField('customerAddress', item.display);
    this.customerAddressSuggestions.set([]);
    this.customerAddressNoMatches.set(false);
  }

  onBusinessAddressInput(value: string): void {
    this.updateField('businessAddress', value);
    this.businessAddressNoMatches.set(false);
    this.queueBusinessAddressLookup(value);
  }

  onBusinessAddressBlur(): void {
    const normalized = String(this.invoice()?.businessAddress || '').trim().toLowerCase();
    if (normalized) {
      const exact = this.businessAddressSuggestions().find(item => item.display.trim().toLowerCase() === normalized);
      if (exact) this.selectBusinessAddressSuggestion(exact);
    }
    setTimeout(() => this.businessAddressSuggestions.set([]), 120);
  }

  selectBusinessAddressSuggestion(item: AddressSuggestion): void {
    this.updateField('businessAddress', item.display);
    this.businessAddressSuggestions.set([]);
    this.businessAddressNoMatches.set(false);
  }

  togglePaymentLink(checked: boolean): void {
    const availability = this.paymentAvailability();
    if (checked && !availability.enabled) return;

    this.invoice.update(current => {
      if (!current) return current;
      const next: InvoiceDetail = {
        ...current,
        includePaymentLink: checked,
        updatedAt: new Date().toISOString()
      };

      if (!checked) {
        next.paymentProviderKey = '';
        next.paymentLinkUrl = '';
      } else if (availability.provider) {
        next.paymentProviderKey = availability.provider.key;
      }
      return next;
    });
    this.clearStatus();
  }

  addLineItem(type: InvoiceLineType = 'part'): void {
    this.invoice.update(current => {
      if (!current) return current;
      const line: InvoiceLineItem = this.recalculateLine({
        id: `li-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        type,
        partStatus: type === 'part' ? 'ordered' : undefined,
        code: '',
        description: '',
        quantity: 1,
        unitPrice: 0,
        taxRate: 0,
        lineSubtotal: 0,
        taxAmount: 0,
        lineTotal: 0
      });
      return {
        ...current,
        lineItems: [...current.lineItems, line],
        updatedAt: new Date().toISOString()
      };
    });
    this.clearStatus();
    this.lineItemsPage.set(this.lineItemsTotalPages());
  }

  removeLineItem(lineId: string): void {
    const id = String(lineId || '').trim();
    if (!id) return;
    this.invoice.update(current => {
      if (!current) return current;
      return {
        ...current,
        lineItems: current.lineItems.filter(line => line.id !== id),
        updatedAt: new Date().toISOString()
      };
    });
    this.clearStatus();
    this.lineItemsPage.update(value => Math.max(1, Math.min(value, this.lineItemsTotalPages())));
  }

  updateLineItemField(lineId: string, field: keyof InvoiceLineItem, rawValue: string): void {
    const id = String(lineId || '').trim();
    if (!id) return;

    this.invoice.update(current => {
      if (!current) return current;
      const nextLines = current.lineItems.map(line => {
        if (line.id !== id) return line;

        const nextLine: InvoiceLineItem = { ...line };
        if (field === 'type') {
          const nextType: InvoiceLineType = rawValue === 'labor' ? 'labor' : 'part';
          nextLine.type = nextType;
          if (nextType === 'labor') {
            nextLine.partStatus = undefined;
          } else {
            nextLine.partStatus = this.normalizePartStatus(nextLine.partStatus);
          }
        } else if (field === 'quantity' || field === 'unitPrice' || field === 'taxRate') {
          const value = this.safeNumber(rawValue);
          (nextLine[field] as number) = value < 0 ? 0 : value;
        } else if (field === 'partStatus') {
          nextLine.partStatus = this.normalizePartStatus(rawValue);
        } else if (field === 'code' || field === 'description') {
          (nextLine[field] as string) = String(rawValue || '');
        }

        return this.recalculateLine(nextLine);
      });

      return {
        ...current,
        lineItems: nextLines,
        updatedAt: new Date().toISOString()
      };
    });
    this.clearStatus();
  }

  async save(): Promise<void> {
    const current = this.invoice();
    if (!current || !this.canSave()) return;

    const availability = this.paymentAvailability();
    if (current.includePaymentLink && !availability.enabled) {
      this.setStatus('Need to connect your payment provider', 'error');
      return;
    }

    this.saving.set(true);
    this.clearStatus();
    try {
      const previousStage = this.invoicesData.getInvoiceById(current.id)?.stage || current.stage;
      let next = this.cloneInvoice(current);
      next.lineItems = next.lineItems.map(line => this.recalculateLine(line));

      if (next.includePaymentLink && availability.provider) {
        next.paymentProviderKey = availability.provider.key;
        if (!String(next.paymentLinkUrl || '').trim()) {
          next.paymentLinkUrl =
            this.paymentSettings.createHostedPaymentLink(next.id, next.invoiceNumber) || next.paymentLinkUrl || '';
        }
      }

      if (!next.includePaymentLink) {
        next.paymentProviderKey = '';
        next.paymentLinkUrl = '';
      }

      if (next.documentType === 'invoice' && this.isFinalInvoiceMode() && next.stage === 'sent') {
        next.timeline = [
          ...(next.timeline || []),
          {
            id: `timeline-${next.id}-final-updated-${Date.now()}`,
            createdAt: new Date().toISOString(),
            message: 'Final invoice updated after send.',
            actorType: 'system',
            createdBy: String(this.auth.user()?.displayName || this.auth.user()?.email || 'Staff').trim()
          }
        ];
      }

      const saved = this.invoicesData.saveInvoice(next);
      await this.notifyInvoiceBuildNeeded(previousStage, saved);
      const autoCompleteOutcome = await this.autoCompleteWorkItemOnInvoiceAccepted(previousStage, saved);
      this.invoice.set(saved);
      this.baselineSnapshot.set(this.snapshot(saved));
      if (autoCompleteOutcome === 'completed') {
        this.setStatus(`${saved.invoiceNumber} saved. Work item moved to Completed.`, 'success');
      } else if (autoCompleteOutcome === 'failed') {
        this.setStatus(`${saved.invoiceNumber} saved. Could not auto-complete active work item.`, 'neutral');
      } else {
        this.setStatus(`${saved.invoiceNumber} saved.`, 'success');
      }
    } catch {
      this.setStatus('Could not save invoice.', 'error');
    } finally {
      this.saving.set(false);
    }
  }

  openAdminSettings(): void {
    void this.router.navigate(['/admin-settings']);
  }

  openInvoiceList(): void {
    const tab = this.invoice()?.documentType === 'quote' ? 'quotes' : 'invoices';
    void this.router.navigate(['/quotes-invoices'], { queryParams: { tab } });
  }

  async createInvoiceFromQuote(): Promise<void> {
    const current = this.invoice();
    if (!current || current.documentType !== 'quote' || current.stage !== 'accepted') return;
    const created = this.invoicesData.createInvoiceFromQuote(current.id);
    if (!created) {
      this.setStatus('Could not create invoice from quote.', 'error');
      return;
    }
    await this.moveQuoteWorkItemToInvoiceLane(current, created);
    void this.router.navigate(['/invoices', created.id]);
  }

  openSendInvoiceModal(): void {
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice' || this.sendingInvoice()) return;
    if (this.isFinalInvoiceSendLocked(detail)) {
      this.setStatus('Final invoice sent. Save updates to enable sending again.', 'neutral');
      return;
    }

    const hasEmail = this.canSendInvoiceViaEmail();
    const hasSms = this.canSendInvoiceViaSms();

    this.sendInvoiceViaEmail.set(hasEmail);
    this.sendInvoiceViaSms.set(hasSms && !hasEmail);
    this.sendInvoiceModalError.set('');
    this.sendInvoiceModalOpen.set(true);
  }

  closeSendInvoiceModal(): void {
    if (this.sendingInvoice()) return;
    this.sendInvoiceModalError.set('');
    this.sendInvoiceModalOpen.set(false);
  }

  setSendInvoiceViaEmail(checked: boolean): void {
    this.sendInvoiceViaEmail.set(checked);
    this.sendInvoiceModalError.set('');
  }

  setSendInvoiceViaSms(checked: boolean): void {
    this.sendInvoiceViaSms.set(checked);
    this.sendInvoiceModalError.set('');
  }

  async confirmSendInvoiceModal(): Promise<void> {
    if (this.sendingInvoice()) return;
    await this.sendInvoiceForPayment({
      email: this.sendInvoiceViaEmail(),
      sms: this.sendInvoiceViaSms()
    });
  }

  async sendInvoiceForPayment(options?: { email: boolean; sms: boolean }): Promise<void> {
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice' || this.sendingInvoice()) return;

    const availability = this.paymentAvailability();

    const emailTarget = String(detail.customerEmail || '').trim();
    const phoneTarget = String(detail.customerPhone || '').trim();
    const wantsEmail = options ? !!options.email : !!emailTarget;
    const wantsSms = options ? !!options.sms : !!phoneTarget;
    if (!wantsEmail && !wantsSms) {
      this.sendInvoiceModalError.set('Pick at least one delivery channel.');
      this.setStatus('Pick at least one delivery channel.', 'error');
      return;
    }
    if (wantsEmail && !emailTarget) {
      this.sendInvoiceModalError.set('Customer email is required to send by email.');
      this.setStatus('Customer email is required to send by email.', 'error');
      return;
    }
    if (wantsSms && !phoneTarget) {
      this.sendInvoiceModalError.set('Customer phone is required to send by SMS.');
      this.setStatus('Customer phone is required to send by SMS.', 'error');
      return;
    }
    const amountDue = this.amountDue();
    if (amountDue <= 0) {
      this.sendInvoiceModalError.set('Invoice balance is already paid. No payment request needed.');
      this.setStatus('Invoice balance is already paid. No payment request needed.', 'error');
      return;
    }

    this.sendingInvoice.set(true);
    this.clearStatus();
    try {
      const paymentLink =
        String(detail.paymentLinkUrl || '').trim()
        || this.paymentSettings.createHostedPaymentLink(detail.id, detail.invoiceNumber)
        || '';
      if (!paymentLink) {
        this.sendInvoiceModalError.set('Payment link unavailable. Connect payment provider or save invoice with a payment link.');
        this.setStatus('Payment link unavailable. Save invoice or connect payment provider, then try again.', 'error');
        return;
      }
      const publicLink = this.invoicePaymentPublicUrl(detail, paymentLink, amountDue);
      const business = String(detail.businessName || '').trim() || 'Your Company';
      const subject = `Invoice ${detail.invoiceNumber} - payment requested`;
      const plainMessage = `Hi ${detail.customerName || 'Customer'}, invoice ${detail.invoiceNumber} has an amount due of ${this.formatUsd(amountDue)}. Pay here: ${publicLink}`;
      const html = this.buildInvoiceEmailHtml(detail, publicLink, business, amountDue);

      const sends: Array<{ channel: 'email' | 'sms'; promise: Promise<unknown> }> = [];
      if (wantsEmail && emailTarget) {
        sends.push({
          channel: 'email',
          promise: firstValueFrom(
            this.emailApi.sendToCustomer({
              customerId: String(detail.customerId || detail.id || '').trim(),
              customerName: String(detail.customerName || '').trim(),
              to: emailTarget,
              subject,
              message: plainMessage,
              html
            })
          )
        });
      }
      if (wantsSms && phoneTarget) {
        sends.push({
          channel: 'sms',
          promise: firstValueFrom(
            this.smsApi.sendToCustomer({
              customerId: String(detail.customerId || detail.id || '').trim(),
              customerName: String(detail.customerName || '').trim(),
              to: phoneTarget,
              message: `${business}: ${detail.invoiceNumber} amount due ${this.formatUsd(amountDue)}. Pay: ${publicLink}`
            })
          )
        });
      }

      const settled = await Promise.allSettled(sends.map(row => row.promise));
      const results = sends.map((row, index) => ({ channel: row.channel, result: settled[index] }));
      const emailSuccess = !wantsEmail || results.some(row => row.channel === 'email' && row.result.status === 'fulfilled');
      const smsSuccess = !wantsSms || results.some(row => row.channel === 'sms' && row.result.status === 'fulfilled');
      const anySuccess = emailSuccess || smsSuccess;

      if (!anySuccess) {
        this.sendInvoiceModalError.set('Invoice send failed. Email/SMS could not be delivered.');
        this.setStatus('Invoice send failed. Email/SMS could not be delivered.', 'error');
        return;
      }

      const sent = this.invoicesData.saveInvoice({
        ...detail,
        includePaymentLink: true,
        paymentProviderKey: availability.provider?.key || detail.paymentProviderKey,
        paymentLinkUrl: paymentLink,
        stage: 'sent',
        timeline: this.isFinalInvoiceMode()
          ? [
              ...(detail.timeline || []),
              {
                id: `timeline-${detail.id}-final-sent-${Date.now()}`,
                createdAt: new Date().toISOString(),
                message: 'Final invoice sent to customer.',
                actorType: 'system',
                createdBy: String(this.auth.user()?.displayName || this.auth.user()?.email || 'Staff').trim()
              }
            ]
          : detail.timeline
      });
      this.invoice.set(sent);
      this.baselineSnapshot.set(this.snapshot(sent));
      this.sendInvoiceModalError.set('');
      this.sendInvoiceModalOpen.set(false);

      let successMessage = '';
      let successTone: StatusTone = 'success';
      if (wantsEmail && wantsSms) {
        if (emailSuccess && smsSuccess) {
          successMessage = 'Invoice sent by email and SMS.';
          successTone = 'success';
        } else if (emailSuccess) {
          successMessage = 'Invoice sent by email. SMS delivery failed.';
          successTone = 'error';
        } else if (smsSuccess) {
          successMessage = 'Invoice sent by SMS. Email delivery failed.';
          successTone = 'error';
        } else {
          successMessage = 'Invoice send failed. Email/SMS could not be delivered.';
          successTone = 'error';
        }
      } else if (wantsEmail) {
        successMessage = emailSuccess ? 'Invoice sent by email.' : 'Invoice send failed. Email could not be delivered.';
        successTone = emailSuccess ? 'success' : 'error';
      } else if (wantsSms) {
        successMessage = smsSuccess ? 'Invoice sent by SMS.' : 'Invoice send failed. SMS could not be delivered.';
        successTone = smsSuccess ? 'success' : 'error';
      } else {
        successMessage = 'Pick at least one delivery channel.';
        successTone = 'error';
      }
      this.setStatusAfterModalClose(successMessage, successTone);
    } catch {
      this.sendInvoiceModalError.set('Could not send invoice.');
      this.setStatus('Could not send invoice.', 'error');
    } finally {
      this.sendingInvoice.set(false);
    }
  }

  async sendQuoteNow(options?: { email: boolean; sms: boolean }): Promise<void> {
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'quote' || this.sendingInvoice()) return;

    const emailTarget = String(detail.customerEmail || '').trim();
    const phoneTarget = String(detail.customerPhone || '').trim();
    const wantsEmail = options ? !!options.email : !!emailTarget;
    const wantsSms = options ? !!options.sms : !!phoneTarget;
    if (!wantsEmail && !wantsSms) {
      this.setStatus('Customer email or phone is required to send this quote.', 'error');
      return;
    }
    if (wantsEmail && !emailTarget) {
      this.setStatus('Customer email is required to send quote by email.', 'error');
      return;
    }
    if (wantsSms && !phoneTarget) {
      this.setStatus('Customer phone is required to send quote by SMS.', 'error');
      return;
    }

    this.sendingInvoice.set(true);
    this.clearStatus();
    try {
      const business = String(detail.businessName || '').trim() || 'Our team';
      const quoteNumber = String(detail.invoiceNumber || 'Quote').trim();
      const subject = `Quote ${quoteNumber} is ready`;
      const viewUrl = this.quoteResponseUrl(detail, 'view');
      const acceptUrl = this.quoteResponseUrl(detail, 'accept');
      const declineUrl = this.quoteResponseUrl(detail, 'decline');
      const plainMessage = `Hi ${detail.customerName || 'Customer'}, your quote ${quoteNumber} is ready. View: ${viewUrl} Accept: ${acceptUrl} Decline: ${declineUrl}`;
      const html = this.buildQuoteEmailHtml(detail, business, viewUrl, acceptUrl, declineUrl);

      const sends: Array<{ channel: 'email' | 'sms'; promise: Promise<unknown> }> = [];
      if (wantsEmail && emailTarget) {
        sends.push({
          channel: 'email',
          promise: firstValueFrom(
            this.emailApi.sendToCustomer({
              customerId: String(detail.customerId || detail.id || '').trim(),
              customerName: String(detail.customerName || '').trim(),
              to: emailTarget,
              subject,
              message: plainMessage,
              html
            })
          )
        });
      }
      if (wantsSms && phoneTarget) {
        sends.push({
          channel: 'sms',
          promise: firstValueFrom(
            this.smsApi.sendToCustomer({
              customerId: String(detail.customerId || detail.id || '').trim(),
              customerName: String(detail.customerName || '').trim(),
              to: phoneTarget,
              message: `${business}: Quote ${quoteNumber}. View: ${viewUrl} Accept: ${acceptUrl} Decline: ${declineUrl}`
            })
          )
        });
      }

      const settled = await Promise.allSettled(sends.map(row => row.promise));
      const results = sends.map((row, index) => ({ channel: row.channel, result: settled[index] }));
      const emailSuccess = !wantsEmail || results.some(row => row.channel === 'email' && row.result.status === 'fulfilled');
      const smsSuccess = !wantsSms || results.some(row => row.channel === 'sms' && row.result.status === 'fulfilled');
      const anySuccess = emailSuccess || smsSuccess;

      if (!anySuccess) {
        this.setStatus('Quote send failed. Email/SMS could not be delivered.', 'error');
        return;
      }

      const sent = this.invoicesData.saveInvoice({
        ...detail,
        stage: 'sent'
      });
      this.invoice.set(sent);
      this.baselineSnapshot.set(this.snapshot(sent));

      if (wantsEmail && wantsSms) {
        if (emailSuccess && smsSuccess) this.setStatus('Quote sent by email and SMS.', 'success');
        else if (emailSuccess) this.setStatus('Quote sent by email. SMS delivery failed.', 'error');
        else if (smsSuccess) this.setStatus('Quote sent by SMS. Email delivery failed.', 'error');
      } else if (wantsEmail) {
        this.setStatus(emailSuccess ? 'Quote sent by email.' : 'Quote send failed. Email could not be delivered.', emailSuccess ? 'success' : 'error');
      } else if (wantsSms) {
        this.setStatus(smsSuccess ? 'Quote sent by SMS.' : 'Quote send failed. SMS could not be delivered.', smsSuccess ? 'success' : 'error');
      }
    } catch {
      this.setStatus('Could not send quote.', 'error');
    } finally {
      this.sendingInvoice.set(false);
    }
  }

  async emailPaidReceipt(): Promise<void> {
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice' || detail.stage !== 'accepted' || this.emailingPaidReceipt()) return;
    const emailTarget = String(detail.customerEmail || '').trim();
    if (!emailTarget) {
      this.setStatus('Customer email is required to send a paid receipt.', 'error');
      return;
    }

    this.emailingPaidReceipt.set(true);
    try {
      const paidDate = this.displayPaidDate(detail);
      const business = String(detail.businessName || '').trim() || 'Your Company';
      const subject = `Receipt: Invoice ${detail.invoiceNumber} paid`;
      const message = `Hi ${detail.customerName || 'Customer'}, payment for invoice ${detail.invoiceNumber} has been received on ${paidDate}. Total paid: ${this.formatUsd(detail.total || 0)}.`;
      const html = this.buildPaidReceiptEmailHtml(detail, business, paidDate);

      await firstValueFrom(this.emailApi.sendToCustomer({
        customerId: String(detail.customerId || detail.id || '').trim(),
        customerName: String(detail.customerName || '').trim(),
        to: emailTarget,
        subject,
        message,
        html
      }));
      this.setStatus('Paid receipt emailed to customer.', 'success');
    } catch {
      this.setStatus('Could not email paid receipt.', 'error');
    } finally {
      this.emailingPaidReceipt.set(false);
    }
  }

  async sendPaidReceiptSms(): Promise<void> {
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice' || detail.stage !== 'accepted' || this.textingPaidReceipt()) return;
    const phoneTarget = String(detail.customerPhone || '').trim();
    if (!phoneTarget) {
      this.setStatus('Customer phone is required to send a paid receipt SMS.', 'error');
      return;
    }

    this.textingPaidReceipt.set(true);
    try {
      const paidDate = this.displayPaidDate(detail);
      const business = String(detail.businessName || '').trim() || 'Your Company';
      await firstValueFrom(this.smsApi.sendToCustomer({
        customerId: String(detail.customerId || detail.id || '').trim(),
        customerName: String(detail.customerName || '').trim(),
        to: phoneTarget,
        message: `${business}: Receipt for ${detail.invoiceNumber}. PAID on ${paidDate}. Total: ${this.formatUsd(detail.total || 0)}.`
      }));
      this.setStatus('Paid receipt SMS sent to customer.', 'success');
    } catch {
      this.setStatus('Could not send paid receipt SMS.', 'error');
    } finally {
      this.textingPaidReceipt.set(false);
    }
  }

  async refundCustomerOverpayment(): Promise<void> {
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice' || this.refundingCustomer()) return;

    const overpayment = this.overpaymentAmount();
    if (overpayment <= 0) {
      this.setStatus('No overpayment found on this invoice.', 'neutral');
      return;
    }

    const allocations = this.buildRefundAllocations(detail, overpayment);
    const refundableTotal = this.roundCurrency(allocations.reduce((sum, item) => sum + item.refundableAmount, 0));
    if (!allocations.length || refundableTotal + 0.009 < overpayment) {
      this.setStatus('Overpayment exists, but no eligible processor transactions are available for automatic refund.', 'error');
      return;
    }

    const confirmed = window.confirm(
      `Refund ${this.formatUsd(overpayment)} to ${detail.customerName || 'customer'} for invoice ${detail.invoiceNumber}?`
    );
    if (!confirmed) return;

    const tenantId = String(this.tenantContext.tenantId() || 'main').trim().toLowerCase() || 'main';
    const reason = 'Overpayment refunded after invoice update.';
    let remaining = overpayment;
    let refundedTotal = 0;
    let latest = detail;

    this.refundingCustomer.set(true);
    this.clearStatus();
    try {
      for (const allocation of allocations) {
        if (remaining <= 0) break;
        const amountToRefund = this.roundCurrency(Math.min(allocation.refundableAmount, remaining));
        if (amountToRefund <= 0) continue;

        const response = await firstValueFrom(this.paymentRefundApi.refund({
          invoiceId: detail.id,
          tenantId,
          provider: allocation.provider,
          amount: amountToRefund.toFixed(2),
          invoiceNumber: detail.invoiceNumber,
          originalTransactionId: allocation.originalTransactionId,
          accountNumber: allocation.accountNumber,
          reason
        }));

        const settled = this.normalizeRefundResponse(response, allocation, amountToRefund);
        const updated = this.invoicesData.recordProcessorRefund(detail.id, {
          provider: settled.provider,
          amount: amountToRefund,
          transactionId: settled.transactionId,
          originalTransactionId: settled.originalTransactionId,
          reason
        });
        if (updated) latest = updated;

        refundedTotal = this.roundCurrency(refundedTotal + amountToRefund);
        remaining = this.roundCurrency(Math.max(0, remaining - amountToRefund));
      }

      if (refundedTotal > 0) {
        this.invoice.set(latest);
        this.baselineSnapshot.set(this.snapshot(latest));
      }

      if (remaining <= 0) {
        this.setStatus(`Refunded ${this.formatUsd(refundedTotal)} back to customer.`, 'success');
        return;
      }

      this.setStatus(
        `Partial refund issued (${this.formatUsd(refundedTotal)}). ${this.formatUsd(remaining)} remains to refund.`,
        'error'
      );
    } catch (err: any) {
      if (refundedTotal > 0) {
        this.invoice.set(latest);
        this.baselineSnapshot.set(this.snapshot(latest));
        this.setStatus(
          `Partial refund issued (${this.formatUsd(refundedTotal)}). Remaining refund failed: ${this.refundErrorMessage(err)}`,
          'error'
        );
      } else {
        this.setStatus(this.refundErrorMessage(err), 'error');
      }
    } finally {
      this.refundingCustomer.set(false);
    }
  }

  printPaidInvoice(): void {
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice') return;
    const popup = window.open('about:blank', '_blank', 'width=1024,height=900');
    if (!popup) {
      this.setStatus('Popup blocked. Enable popups to print invoice.', 'error');
      return;
    }

    const html = detail.stage === 'accepted'
      ? this.buildPaidReceiptPrintHtml(detail, this.displayPaidDate(detail))
      : this.buildInvoicePrintHtml(detail);
    try {
      popup.document.open('text/html', 'replace');
      popup.document.write(html);
      popup.document.close();
    } catch {
      this.setStatus('Could not render print preview. Please try again.', 'error');
      return;
    }

    const triggerPrint = () => {
      try {
        popup.focus();
        popup.print();
      } catch {
        this.setStatus('Could not open print dialog. Please use browser print.', 'error');
      }
    };

    // Some browsers need a load boundary before printing newly written popup content.
    popup.onload = () => setTimeout(triggerPrint, 120);
    setTimeout(triggerPrint, 280);
  }

  trackLineItem(_index: number, line: InvoiceLineItem): string {
    return line.id;
  }

  prevLineItemsPage(): void {
    this.lineItemsPage.update(value => Math.max(1, value - 1));
  }

  nextLineItemsPage(): void {
    this.lineItemsPage.update(value => Math.min(this.lineItemsTotalPages(), value + 1));
  }

  timelineMarkerKind(message: string): 'default' | 'draft' | 'sent' | 'accepted' | 'declined' | 'paused' {
    const text = String(message || '').toLowerCase();
    if (text.includes('declin') || text.includes('cancel') || text.includes('expir')) return 'declined';
    if (text.includes('accept') || text.includes('paid') || text.includes('complet')) return 'accepted';
    if (text.includes('sent')) return 'sent';
    if (text.includes('pause') || text.includes('hold')) return 'paused';
    if (text.includes('creat') || text.includes('draft')) return 'draft';
    return 'default';
  }

  timelineMarkerGlyph(message: string): string {
    const kind = this.timelineMarkerKind(message);
    if (kind === 'draft') return 'document-outline';
    if (kind === 'sent') return 'mail-open-outline';
    if (kind === 'accepted') return 'checkmark-outline';
    if (kind === 'declined') return 'close-outline';
    if (kind === 'paused') return 'pause-outline';
    return 'alert-circle-outline';
  }

  isCustomerTimelineEntry(entry: InvoiceTimelineEntry): boolean {
    const actorType = String(entry.actorType || '').trim().toLowerCase();
    if (actorType === 'customer') return true;
    const text = String(entry.message || '').toLowerCase();
    return text.includes('customer accepted')
      || text.includes('customer declined')
      || text.includes('customer paid')
      || text.includes('from public link');
  }

  timelineActorName(entry: InvoiceTimelineEntry): string {
    if (this.isCustomerTimelineEntry(entry)) {
      const by = String(entry.createdBy || '').trim();
      if (by && by.toLowerCase() !== 'customer') return by;
      const invoiceCustomer = String(this.invoice()?.customerName || '').trim();
      return invoiceCustomer || 'Customer';
    }
    const by = String(entry.createdBy || '').trim();
    if (by) return by;
    const user = this.auth.user();
    return String(user?.displayName || user?.email || 'System').trim();
  }

  private buildRefundAllocations(detail: InvoiceDetail, targetAmount: number): RefundAllocation[] {
    const wanted = this.roundCurrency(Math.max(0, Number(targetAmount || 0)));
    if (wanted <= 0) return [];

    const refundsByOriginal = new Map<string, number>();
    for (const refund of detail.refundTransactions || []) {
      const originalTransactionId = this.safeText((refund as InvoiceRefundTransaction).originalTransactionId);
      if (!originalTransactionId) continue;
      const refunded = this.roundCurrency(Math.max(0, Number((refund as InvoiceRefundTransaction).amount || 0)));
      const next = this.roundCurrency((refundsByOriginal.get(originalTransactionId) || 0) + refunded);
      refundsByOriginal.set(originalTransactionId, next);
    }

    const payments = [...(detail.paymentTransactions || [])]
      .sort((a, b) => Date.parse(String(b.createdAt || '').trim()) - Date.parse(String(a.createdAt || '').trim()));

    let remainingTarget = wanted;
    const allocations: RefundAllocation[] = [];

    for (const payment of payments) {
      if (remainingTarget <= 0) break;
      const provider = this.safeText((payment as InvoicePaymentTransaction).provider).toLowerCase();
      if (!this.supportsAutomatedRefund(provider)) continue;

      const transactionId = this.safeText((payment as InvoicePaymentTransaction).transactionId);
      if (!transactionId) continue;

      const accountNumber = this.maskedAccountForRefund(this.safeText((payment as InvoicePaymentTransaction).accountNumber));
      if (!accountNumber) continue;

      const paid = this.roundCurrency(Math.max(0, Number((payment as InvoicePaymentTransaction).amount || 0)));
      const refunded = this.roundCurrency(Math.max(0, Number(refundsByOriginal.get(transactionId) || 0)));
      const available = this.roundCurrency(Math.max(0, paid - refunded));
      if (available <= 0) continue;

      const portion = this.roundCurrency(Math.min(available, remainingTarget));
      allocations.push({
        provider,
        originalTransactionId: transactionId,
        accountNumber,
        refundableAmount: portion
      });
      remainingTarget = this.roundCurrency(Math.max(0, remainingTarget - portion));
    }

    return allocations;
  }

  private normalizeRefundResponse(
    response: PaymentRefundResponse,
    fallback: RefundAllocation,
    amount: number
  ): { provider: string; transactionId: string; originalTransactionId: string; amount: number } {
    const provider = this.safeText(response?.provider || fallback.provider).toLowerCase() || fallback.provider;
    const originalTransactionId = this.safeText(response?.originalTransactionId || fallback.originalTransactionId) || fallback.originalTransactionId;
    const transactionId = this.safeText(response?.refundTransactionId || (response as any)?.transactionId)
      || `manual-refund-${Date.now()}`;
    return {
      provider,
      transactionId,
      originalTransactionId,
      amount: this.roundCurrency(Math.max(0, Number(amount || 0)))
    };
  }

  private refundErrorMessage(err: any): string {
    const error = String(err?.error?.error || '').trim();
    const detail = String(err?.error?.detail || '').trim();
    const fallback = String(err?.message || '').trim();
    if (error && detail) return `${error} (${detail})`;
    if (error) return error;
    if (detail) return detail;
    if (fallback) return fallback;
    return 'Refund failed. Verify processor settings and try again.';
  }

  private supportsAutomatedRefund(provider: string): boolean {
    return this.safeText(provider).toLowerCase() === 'authorize-net';
  }

  private maskedAccountForRefund(raw: string): string {
    const digits = String(raw || '').replace(/\D+/g, '');
    if (digits.length < 4) return '';
    return `XXXX${digits.slice(-4)}`;
  }

  private loadInvoice(id: string): void {
    this.loading.set(true);
    this.error.set('');
    this.clearStatus();
    this.resolveInvoiceFromStore(id);
  }

  private resolveInvoiceFromStore(id: string): void {
    if (!id) {
      this.invoice.set(null);
      this.error.set('Invoice not found.');
      this.loading.set(false);
      return;
    }

    const expectedType = this.expectedDocumentTypeFromRoute();
    const found = this.findBestInvoiceForRoute(id, expectedType);
    if (!found) {
      if (!this.invoice() || this.invoice()!.id !== id) {
        this.invoice.set(null);
        this.error.set('Invoice not found.');
      }
      this.loading.set(false);
      return;
    }

    const current = this.invoice();
    const foundSnapshot = this.snapshot(found);
    const canHydrate =
      !current
      || current.id !== found.id
      || this.snapshot(current) !== foundSnapshot;
    if (canHydrate) {
      this.invoice.set(found);
      this.baselineSnapshot.set(foundSnapshot);
      this.lineItemsPage.set(1);
    }
    this.error.set('');
    this.loading.set(false);
    this.scheduleAutoOpenSendModal();
    this.scheduleAutoSendNow();
  }

  private maybeOpenSendModalFromQuery(): void {
    if (!this.pendingOpenSendModal) return;
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice') return;
    this.pendingOpenSendModal = false;
    this.openSendInvoiceModal();
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { openSendModal: null },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  private scheduleAutoOpenSendModal(): void {
    if (!this.pendingOpenSendModal) return;
    if (this.autoOpenSendModalTimer) clearTimeout(this.autoOpenSendModalTimer);
    this.autoOpenSendModalTimer = setTimeout(() => {
      this.autoOpenSendModalTimer = null;
      this.maybeOpenSendModalFromQuery();
    }, 0);
  }

  private maybeSendNowFromQuery(): void {
    if (!this.pendingSendNow) return;
    const detail = this.invoice();
    if (!detail || detail.stage !== 'draft') return;
    this.pendingSendNow = false;
    const wantsEmail = !!String(detail.customerEmail || '').trim();
    const wantsSms = !!String(detail.customerPhone || '').trim();
    if (detail.documentType === 'invoice') {
      void this.sendInvoiceForPayment({ email: wantsEmail, sms: wantsSms });
    } else {
      void this.sendQuoteNow({ email: wantsEmail, sms: wantsSms });
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { sendNow: null },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  private scheduleAutoSendNow(): void {
    if (!this.pendingSendNow) return;
    if (this.autoSendNowTimer) clearTimeout(this.autoSendNowTimer);
    this.autoSendNowTimer = setTimeout(() => {
      this.autoSendNowTimer = null;
      this.maybeSendNowFromQuery();
    }, 0);
  }

  private expectedDocumentTypeFromRoute(): InvoiceDocumentType {
    const path = String(this.route.snapshot.routeConfig?.path || '').trim().toLowerCase();
    if (path.startsWith('quotes')) return 'quote';
    return 'invoice';
  }

  private findBestInvoiceForRoute(id: string, expectedType: InvoiceDocumentType): InvoiceDetail | null {
    const key = String(id || '').trim();
    if (!key) return null;
    const lookup = key.toLowerCase();
    const details = this.invoicesData.invoiceDetails();
    const matches = details.filter(item => {
      if (item.documentType !== expectedType) return false;
      const itemId = String(item.id || '').trim();
      const number = String(item.invoiceNumber || '').trim().toLowerCase();
      return itemId === key || itemId.toLowerCase() === lookup || number === lookup;
    });

    if (matches.length) {
      const ranked = matches.slice().sort((a, b) => {
        const stageDiff = this.stagePriorityForRoute(b.stage) - this.stagePriorityForRoute(a.stage);
        if (stageDiff !== 0) return stageDiff;
        const updatedDiff = Date.parse(String(b.updatedAt || b.createdAt || '').trim()) - Date.parse(String(a.updatedAt || a.createdAt || '').trim());
        if (Number.isFinite(updatedDiff) && updatedDiff !== 0) return updatedDiff;
        return Date.parse(String(b.createdAt || '').trim()) - Date.parse(String(a.createdAt || '').trim());
      });
      return ranked[0];
    }
    return this.invoicesData.getInvoiceById(key);
  }

  private stagePriorityForRoute(stage: InvoiceStage): number {
    const normalized = String(stage || '').trim().toLowerCase();
    if (normalized === 'completed' || normalized === 'complete') return 7;
    if (normalized === 'accepted' || normalized === 'paid') return 6;
    if (normalized === 'sent') return 5;
    if (normalized === 'draft') return 4;
    if (normalized === 'declined') return 3;
    if (normalized === 'expired') return 2;
    if (normalized === 'canceled') return 1;
    return 0;
  }

  private snapshot(invoice: InvoiceDetail): string {
    return JSON.stringify(invoice);
  }

  private cloneInvoice(invoice: InvoiceDetail): InvoiceDetail {
    return {
      ...invoice,
      lineItems: invoice.lineItems.map(line => ({ ...line })),
      timeline: invoice.timeline.map(entry => ({ ...entry })),
      paymentTransactions: (invoice.paymentTransactions || []).map(item => ({ ...item })),
      refundTransactions: (invoice.refundTransactions || []).map(item => ({ ...item }))
    };
  }

  private async autoCompleteWorkItemOnInvoiceAccepted(
    previousStage: InvoiceStage,
    saved: InvoiceDetail
  ): Promise<'completed' | 'failed' | 'noop'> {
    const movedToSettled = saved.stage === 'accepted' || saved.stage === 'completed';
    const alreadySettled = previousStage === 'accepted' || previousStage === 'completed';
    if (alreadySettled || !movedToSettled) return 'noop';

    const customerId = String(saved.customerId || '').trim();
    if (!customerId) return 'noop';

    try {
      const [lanes, allItems] = await Promise.all([
        firstValueFrom(this.lanesApi.list()),
        firstValueFrom(this.workItemsApi.list())
      ]);
      const completedLaneId = this.completedLaneId(lanes || []);
      if (!completedLaneId) return 'failed';

      const target = this.findActiveWorkItemForCustomer(allItems || [], lanes || [], customerId);
      if (!target) return 'noop';

      const nowIso = new Date().toISOString();
      const patch: Partial<WorkItem> & { id: string } = {
        id: target.id,
        laneId: completedLaneId,
        completedAt: nowIso,
        calendarOverrideAt: ''
      };
      Object.assign(patch, this.buildCompletionTimingPatch(target, nowIso));

      await firstValueFrom(this.workItemsApi.update(patch));
      return 'completed';
    } catch {
      return 'failed';
    }
  }

  private findActiveWorkItemForCustomer(
    allItems: WorkItem[],
    lanes: Lane[],
    customerId: string
  ): WorkItem | null {
    const lookup = customerId.trim().toLowerCase();
    if (!lookup) return null;

    const candidates = (allItems || []).filter(item => {
      const itemCustomer = String(item.customerId || '').trim().toLowerCase();
      if (!itemCustomer || itemCustomer !== lookup) return false;
      if (!String(item.checkedInAt || '').trim()) return false;
      if (String(item.completedAt || '').trim()) return false;
      return true;
    });
    if (!candidates.length) return null;

    const inProgress = candidates.filter(item => this.laneStageKey(this.findLaneById(lanes, item.laneId)) === 'inprogress');
    const ordered = (inProgress.length ? inProgress : candidates).sort(
      (a, b) => this.itemWorkSortTime(b) - this.itemWorkSortTime(a)
    );
    return ordered[0] || null;
  }

  private findLaneById(lanes: Lane[], laneId: string): Lane | null {
    if (!laneId) return null;
    return (lanes || []).find(lane => lane.id === laneId) || null;
  }

  private completedLaneId(lanes: Lane[]): string | null {
    const explicit = (lanes || []).find(lane => String(lane.stageKey || '').trim().toLowerCase() === 'completed');
    if (explicit?.id) return explicit.id;

    const inferred = (lanes || []).find(lane => /complete|completed|done|ready|pickup/.test(String(lane.name || '').toLowerCase()));
    return inferred?.id || null;
  }

  private invoicedLaneId(lanes: Lane[]): string | null {
    const explicit = (lanes || []).find(lane => String(lane.stageKey || '').trim().toLowerCase() === 'invoiced');
    if (explicit?.id) return explicit.id;
    const inferred = (lanes || []).find(lane => /invoice|invoiced|billing|bill|paid/.test(String(lane.name || '').toLowerCase()));
    return inferred?.id || null;
  }

  private laneStageKey(lane: Lane | null): string {
    const explicit = String(lane?.stageKey || '').trim().toLowerCase();
    if (explicit) return explicit;
    const name = String(lane?.name || '').trim().toLowerCase();
    if (!name) return 'custom';
    if (/lead|new lead|prospect/.test(name)) return 'lead';
    if (/quote|estimate/.test(name)) return 'quote';
    if (/invoice|invoiced|billing|bill|paid/.test(name)) return 'invoiced';
    if (/schedule|appointment|booked/.test(name)) return 'scheduled';
    if (/in[- ]?progress|work in progress|progress/.test(name)) return 'inprogress';
    if (/complete|completed|done|pickup|ready/.test(name)) return 'completed';
    return 'custom';
  }

  private async moveQuoteWorkItemToInvoiceLane(sourceQuote: InvoiceDetail, createdInvoice: InvoiceDetail): Promise<void> {
    try {
      const [lanes, allItems] = await Promise.all([
        firstValueFrom(this.lanesApi.list()),
        firstValueFrom(this.workItemsApi.list())
      ]);
      const quoteLaneCandidates = (allItems || []).filter(item => {
        const stage = this.laneStageKey(this.findLaneById(lanes || [], item.laneId));
        if (stage !== 'quote') return false;
        return this.matchesQuoteWorkItem(item, sourceQuote);
      });
      const candidates = quoteLaneCandidates.sort((a, b) => this.itemWorkSortTime(b) - this.itemWorkSortTime(a));
      if (!candidates.length) return;

      const target = candidates[0];
      if (!target) return;

      const invoiceLaneId = this.invoicedLaneId(lanes || []);
      if (invoiceLaneId && target.laneId !== invoiceLaneId) {
        await firstValueFrom(this.workItemsApi.update({
          id: target.id,
          laneId: invoiceLaneId
        }));
        this.setStatus(`Created invoice ${createdInvoice.invoiceNumber} and moved customer to Invoices lane.`, 'success');
        return;
      }

      await firstValueFrom(this.workItemsApi.delete(target.id));
      this.setStatus(`Created invoice ${createdInvoice.invoiceNumber} and removed accepted quote from Quotes lane.`, 'success');
    } catch {
      this.setStatus(`Created invoice ${createdInvoice.invoiceNumber}. Move customer card to Invoices lane if needed.`, 'neutral');
    }
  }

  private matchesQuoteWorkItem(item: WorkItem, sourceQuote: InvoiceDetail): boolean {
    const quoteCustomerId = String(sourceQuote.customerId || '').trim();
    const itemCustomerId = String(item.customerId || '').trim();
    if (quoteCustomerId && itemCustomerId && quoteCustomerId === itemCustomerId) return true;

    const customerName = String(sourceQuote.customerName || '').trim().toLowerCase();
    const title = String(item.title || '').trim().toLowerCase();
    if (customerName && title && title.includes(customerName)) return true;

    return false;
  }

  private itemWorkSortTime(item: WorkItem): number {
    return Math.max(
      this.asMillis(item.checkedInAt),
      this.asMillis(item.updatedAt),
      this.asMillis(item.createdAt)
    );
  }

  private asMillis(value: string | null | undefined): number {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private elapsedMs(fromIso: string | null | undefined, toIso: string): number {
    const from = this.asMillis(fromIso);
    const to = this.asMillis(toIso);
    if (!from || !to || to <= from) return 0;
    return to - from;
  }

  private safeDuration(value: unknown): number {
    const duration = Number(value);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  }

  private buildCompletionTimingPatch(item: WorkItem, nowIso: string): Partial<WorkItem> {
    const isPaused = !!item.isPaused || !!String(item.pausedAt || '').trim();
    const workIncrement = isPaused
      ? 0
      : this.elapsedMs(
          String(item.lastWorkResumedAt || '').trim() || String(item.checkedInAt || '').trim(),
          nowIso
        );
    const pauseIncrement = isPaused ? this.elapsedMs(item.pausedAt, nowIso) : 0;

    return {
      isPaused: false,
      pausedAt: '',
      lastWorkResumedAt: '',
      workDurationMs: this.safeDuration(item.workDurationMs) + workIncrement,
      pauseDurationMs: this.safeDuration(item.pauseDurationMs) + pauseIncrement
    };
  }

  private recalculateLine(line: InvoiceLineItem): InvoiceLineItem {
    const quantity = this.safeNumber(line.quantity, 0);
    const unitPrice = this.safeNumber(line.unitPrice, 0);
    const taxRate = this.safeNumber(line.taxRate, 0);
    const lineSubtotal = this.roundCurrency(quantity * unitPrice);
    const taxAmount = this.roundCurrency((lineSubtotal * taxRate) / 100);
    const lineTotal = this.roundCurrency(lineSubtotal + taxAmount);
    return {
      ...line,
      partStatus: line.type === 'part' ? this.normalizePartStatus(line.partStatus) : undefined,
      quantity,
      unitPrice,
      taxRate,
      lineSubtotal,
      taxAmount,
      lineTotal
    };
  }

  private safeNumber(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed;
  }

  private roundCurrency(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private isStage(value: string): value is InvoiceStage {
    return value === 'draft' || value === 'sent' || value === 'accepted' || value === 'completed' || value === 'declined';
  }

  private normalizeBoardStage(value: unknown): InvoiceBoardStage {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'draft') return 'draft';
    if (normalized === 'sent') return 'sent';
    if (normalized === 'accepted' || normalized === 'paid') return 'accepted';
    if (normalized === 'completed' || normalized === 'complete') return 'completed';
    if (normalized === 'declined') return 'declined';
    return 'draft';
  }

  private normalizePartStatus(value: unknown): InvoicePartStatus {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'in-stock' || normalized === 'in stock' || normalized === 'instock') return 'in-stock';
    if (normalized === 'backordered' || normalized === 'back-order' || normalized === 'back order') return 'backordered';
    if (normalized === 'received') return 'received';
    return 'ordered';
  }

  private invoicePaymentPublicUrl(detail: InvoiceDetail, paymentLink: string, amountDue: number): string {
    const query = new URLSearchParams();
    query.set('invoiceId', detail.id);
    query.set('tenantId', String(this.tenantContext.tenantId() || 'main').trim().toLowerCase() || 'main');
    query.set('invoiceNumber', detail.invoiceNumber);
    query.set('customerName', detail.customerName || 'Customer');
    query.set('customerEmail', String(detail.customerEmail || '').trim());
    query.set('vehicle', detail.vehicle || 'Vehicle details pending');
    query.set('businessName', detail.businessName || 'Our team');
    query.set('amount', new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amountDue));
    query.set('dueDate', detail.dueDate || '');
    query.set('paymentUrl', paymentLink);
    query.set('paymentProvider', String(detail.paymentProviderKey || '').trim().toLowerCase());
    return this.publicRouteUrl('/invoice-payment', query);
  }

  private quoteResponseUrl(detail: InvoiceDetail, action: 'view' | 'accept' | 'decline'): string {
    const path = action === 'accept' ? '/quote-accepted' : action === 'decline' ? '/quote-declined' : '/quote-response';
    const query = new URLSearchParams();
    query.set('action', action);
    query.set('quoteId', String(detail.id || '').trim());
    query.set('tenantId', String(this.tenantContext.tenantId() || 'main').trim().toLowerCase() || 'main');
    query.set('quoteNumber', String(detail.invoiceNumber || '').trim());
    query.set('customerName', String(detail.customerName || 'Customer').trim());
    query.set('vehicle', String(detail.vehicle || 'Vehicle details pending').trim());
    query.set('businessName', String(detail.businessName || 'Our team').trim());
    const quotePayload = this.buildPublicQuotePayload(detail);
    if (quotePayload) query.set('quoteData', quotePayload);
    return this.publicRouteUrl(path, query);
  }

  private buildQuoteEmailHtml(
    detail: InvoiceDetail,
    business: string,
    viewUrl: string,
    acceptUrl: string,
    declineUrl: string
  ): string {
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const quoteNumber = String(detail.invoiceNumber || 'Quote').trim();
    const issueDate = String(detail.issueDate || '').trim();
    const dueDate = String(detail.dueDate || '').trim();
    const subtotal = Number(detail.subtotal || 0);
    const taxTotal = Number(detail.taxTotal || 0);
    const total = Number(detail.total || 0);
    const logoUrl = this.resolveEmailLogoUrl(detail.businessLogoUrl || '');
    const itemRows = (detail.lineItems || [])
      .map(item => `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#111827;">${this.escapeHtml(item.type === 'labor' ? 'Labor' : 'Part')}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#111827;">${this.escapeHtml(item.code || '')}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#111827;">${this.escapeHtml(item.description || '')}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#111827;text-align:right;">${this.escapeHtml(String(item.quantity || 0))}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#111827;text-align:right;">${this.escapeHtml(money.format(Number(item.unitPrice || 0)))}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#111827;text-align:right;">${this.escapeHtml(money.format(Number(item.lineTotal || 0)))}</td>
        </tr>
      `)
      .join('');
    const customerNote = String(detail.customerNote || '').trim();
    const staffNote = String(detail.staffNote || '').trim();
    const description = String(detail.description || '').trim();
    return `
      <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.45;color:#0f172a;max-width:960px;margin:0 auto;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
          <tr>
            <td style="vertical-align:top;padding:8px 0;">
              ${logoUrl ? `<img src="${this.escapeHtml(logoUrl)}" alt="${this.escapeHtml(business)} logo" style="max-height:72px;max-width:220px;display:block;margin:0 0 10px 0;">` : ''}
              <div style="font-size:22px;font-weight:800;color:#111827;">${this.escapeHtml(business)}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail.businessAddress || '').trim())}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail.businessPhone || '').trim())}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail.businessEmail || '').trim())}</div>
            </td>
            <td style="vertical-align:top;text-align:right;padding:8px 0;">
              <div style="font-size:34px;letter-spacing:.08em;font-weight:800;color:#1f2937;">QUOTE</div>
              <div style="margin-top:10px;color:#111827;"><strong>Quote #:</strong> ${this.escapeHtml(quoteNumber)}</div>
              <div style="color:#111827;"><strong>Issue Date:</strong> ${this.escapeHtml(issueDate)}</div>
              <div style="color:#111827;"><strong>Due Date:</strong> ${this.escapeHtml(dueDate)}</div>
            </td>
          </tr>
        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
          <tr>
            <td style="vertical-align:top;">
              <div style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;">Prepared For</div>
              <div style="font-size:18px;font-weight:700;color:#111827;">${this.escapeHtml(detail.customerName || 'Customer')}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail.customerAddress || '').trim())}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail.customerPhone || '').trim())}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail.customerEmail || '').trim())}</div>
              <div style="color:#334155;"><strong>Vehicle:</strong> ${this.escapeHtml(String(detail.vehicle || 'Vehicle details pending').trim())}</div>
            </td>
          </tr>
        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:14px 0;">
          <thead>
            <tr>
              <th style="background:#d1d5db;color:#111827;text-align:left;padding:10px;">Type</th>
              <th style="background:#d1d5db;color:#111827;text-align:left;padding:10px;">Code</th>
              <th style="background:#d1d5db;color:#111827;text-align:left;padding:10px;">Description</th>
              <th style="background:#d1d5db;color:#111827;text-align:right;padding:10px;">Qty</th>
              <th style="background:#d1d5db;color:#111827;text-align:right;padding:10px;">Price</th>
              <th style="background:#d1d5db;color:#111827;text-align:right;padding:10px;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${itemRows || '<tr><td colspan="6" style="padding:10px;border-bottom:1px solid #e5e7eb;color:#64748b;">No line items.</td></tr>'}
          </tbody>
        </table>

        <table role="presentation" align="right" cellpadding="0" cellspacing="0" border="0" style="width:340px;max-width:100%;border:1px solid #cbd5e1;border-radius:8px;background:#f1f5f9;margin:6px 0 18px;">
          <tr>
            <td style="padding:8px 10px;color:#111827;">Subtotal:</td>
            <td style="padding:8px 10px;color:#111827;text-align:right;font-weight:700;">${this.escapeHtml(money.format(subtotal))}</td>
          </tr>
          <tr>
            <td style="padding:8px 10px;color:#111827;">Tax:</td>
            <td style="padding:8px 10px;color:#111827;text-align:right;font-weight:700;">${this.escapeHtml(money.format(taxTotal))}</td>
          </tr>
          <tr>
            <td style="padding:10px;background:#e2e8f0;color:#111827;font-weight:800;">Quote Total:</td>
            <td style="padding:10px;background:#e2e8f0;color:#111827;text-align:right;font-weight:800;">${this.escapeHtml(money.format(total))}</td>
          </tr>
        </table>

        <div style="clear:both;"></div>
        <p style="margin:0 0 14px;">
          <a href="${this.escapeHtml(viewUrl)}" style="display:inline-block;margin-right:8px;background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:700;">View Quote</a>
          <a href="${this.escapeHtml(acceptUrl)}" style="display:inline-block;margin-right:8px;background:#16a34a;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:700;">Accept Quote</a>
          <a href="${this.escapeHtml(declineUrl)}" style="display:inline-block;background:#ef4444;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:700;">Decline Quote</a>
        </p>
        ${description ? `<p style="margin:8px 0 0;color:#334155;"><strong>Description:</strong> ${this.escapeHtml(description)}</p>` : ''}
        ${customerNote ? `<p style="margin:8px 0 0;color:#334155;"><strong>Customer Note:</strong> ${this.escapeHtml(customerNote)}</p>` : ''}
        ${staffNote ? `<p style="margin:8px 0 0;color:#334155;"><strong>Terms:</strong> ${this.escapeHtml(staffNote)}</p>` : ''}
        <p style="margin:14px 0 0;color:#334155;">If you have questions, reply to this email and ${this.escapeHtml(business)} will help.</p>
      </div>
    `;
  }

  private buildPublicQuotePayload(detail: InvoiceDetail): string {
    try {
      const payload = {
        quoteId: String(detail.id || '').trim(),
        quoteNumber: String(detail.invoiceNumber || '').trim(),
        customerName: String(detail.customerName || '').trim(),
        customerEmail: String(detail.customerEmail || '').trim(),
        customerPhone: String(detail.customerPhone || '').trim(),
        customerAddress: String(detail.customerAddress || '').trim(),
        vehicle: String(detail.vehicle || '').trim(),
        businessName: String(detail.businessName || '').trim(),
        businessEmail: String(detail.businessEmail || '').trim(),
        businessPhone: String(detail.businessPhone || '').trim(),
        businessAddress: String(detail.businessAddress || '').trim(),
        businessLogoUrl: String(detail.businessLogoUrl || '').trim(),
        issueDate: String(detail.issueDate || '').trim(),
        dueDate: String(detail.dueDate || '').trim(),
        description: String(detail.description || '').trim(),
        customerNote: String(detail.customerNote || '').trim(),
        staffNote: String(detail.staffNote || '').trim(),
        subtotal: this.roundCurrency(Number(detail.subtotal || 0)),
        taxTotal: this.roundCurrency(Number(detail.taxTotal || 0)),
        total: this.roundCurrency(Number(detail.total || 0)),
        lineItems: (detail.lineItems || []).map(line => ({
          type: String(line.type || '').trim().toLowerCase(),
          code: String(line.code || '').trim(),
          description: String(line.description || '').trim(),
          quantity: Number(line.quantity || 0),
          unitPrice: this.roundCurrency(Number(line.unitPrice || 0)),
          taxRate: this.roundCurrency(Number(line.taxRate || 0)),
          lineSubtotal: this.roundCurrency(Number(line.lineSubtotal || 0)),
          taxAmount: this.roundCurrency(Number(line.taxAmount || 0)),
          lineTotal: this.roundCurrency(Number(line.lineTotal || 0))
        }))
      };
      return this.encodeQuotePayload(payload);
    } catch {
      return '';
    }
  }

  private encodeQuotePayload(payload: unknown): string {
    try {
      const json = JSON.stringify(payload || {});
      if (typeof TextEncoder !== 'undefined' && typeof btoa === 'function') {
        const bytes = new TextEncoder().encode(json);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 1) {
          binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      }
      if (typeof btoa === 'function') {
        return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      }
      return '';
    } catch {
      return '';
    }
  }

  private buildInvoiceEmailHtml(detail: InvoiceDetail, publicLink: string, business: string, amountDue: number): string {
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const subtotal = Number(detail.subtotal || 0);
    const taxTotal = Number(detail.taxTotal || 0);
    const total = Number(detail.total || 0);
    const paid = this.normalizePaidAmount(detail.paidAmount);
    const dueDate = String(detail.dueDate || '').trim();
    const issueDate = String(detail.issueDate || '').trim();
    const logoUrl = this.resolveEmailLogoUrl(detail.businessLogoUrl || '');

    const itemRows = (detail.lineItems || [])
      .map(item => `
        <tr>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#111827;">${this.escapeHtml(item.type === 'labor' ? 'Labor' : 'Part')}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#111827;">${this.escapeHtml(item.description || '')}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#111827;text-align:right;">${this.escapeHtml(String(item.quantity || 0))}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#111827;text-align:right;">${this.escapeHtml(money.format(Number(item.unitPrice || 0)))}</td>
          <td style="padding:10px;border-bottom:1px solid #e5e7eb;color:#111827;text-align:right;">${this.escapeHtml(money.format(Number(item.lineTotal || 0)))}</td>
        </tr>
      `)
      .join('');

    return `
      <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.45;color:#0f172a;max-width:960px;margin:0 auto;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:16px;">
          <tr>
            <td style="vertical-align:top;padding:8px 0;">
              ${logoUrl ? `<img src="${this.escapeHtml(logoUrl)}" alt="${this.escapeHtml(business)} logo" style="max-height:72px;max-width:220px;display:block;margin:0 0 10px 0;">` : ''}
              <div style="font-size:22px;font-weight:800;color:#111827;">${this.escapeHtml(business)}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail.businessAddress || '').trim())}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail.businessPhone || '').trim())}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail.businessEmail || '').trim())}</div>
            </td>
            <td style="vertical-align:top;text-align:right;padding:8px 0;">
              <div style="font-size:34px;letter-spacing:.08em;font-weight:800;color:#1f2937;">INVOICE</div>
              <div style="margin-top:10px;color:#111827;"><strong>Invoice #:</strong> ${this.escapeHtml(detail.invoiceNumber)}</div>
              <div style="color:#111827;"><strong>Invoice Date:</strong> ${this.escapeHtml(issueDate)}</div>
              <div style="color:#111827;"><strong>Due Date:</strong> ${this.escapeHtml(dueDate)}</div>
            </td>
          </tr>
        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
          <tr>
            <td style="vertical-align:top;">
              <div style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;">Bill To</div>
              <div style="font-size:18px;font-weight:700;color:#111827;">${this.escapeHtml(detail.customerName || 'Customer')}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail.customerAddress || '').trim())}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail.customerPhone || '').trim())}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail.customerEmail || '').trim())}</div>
              <div style="color:#334155;"><strong>Vehicle:</strong> ${this.escapeHtml(String(detail.vehicle || 'Vehicle details pending').trim())}</div>
            </td>
          </tr>
        </table>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:14px 0;">
          <thead>
            <tr>
              <th style="background:#d1d5db;color:#111827;text-align:left;padding:10px;">Item</th>
              <th style="background:#d1d5db;color:#111827;text-align:left;padding:10px;">Description</th>
              <th style="background:#d1d5db;color:#111827;text-align:right;padding:10px;">Qty</th>
              <th style="background:#d1d5db;color:#111827;text-align:right;padding:10px;">Price</th>
              <th style="background:#d1d5db;color:#111827;text-align:right;padding:10px;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${itemRows || '<tr><td colspan="5" style="padding:10px;border-bottom:1px solid #e5e7eb;color:#64748b;">No line items.</td></tr>'}
          </tbody>
        </table>

        <table role="presentation" align="right" cellpadding="0" cellspacing="0" border="0" style="width:340px;max-width:100%;border:1px solid #cbd5e1;border-radius:8px;background:#f1f5f9;margin:6px 0 18px;">
          <tr>
            <td style="padding:8px 10px;color:#111827;">Subtotal:</td>
            <td style="padding:8px 10px;color:#111827;text-align:right;font-weight:700;">${this.escapeHtml(money.format(subtotal))}</td>
          </tr>
          <tr>
            <td style="padding:8px 10px;color:#111827;">Tax:</td>
            <td style="padding:8px 10px;color:#111827;text-align:right;font-weight:700;">${this.escapeHtml(money.format(taxTotal))}</td>
          </tr>
          <tr>
            <td style="padding:10px;background:#e2e8f0;color:#111827;font-weight:800;">Total Due:</td>
            <td style="padding:10px;background:#e2e8f0;color:#111827;text-align:right;font-weight:800;">${this.escapeHtml(money.format(amountDue))}</td>
          </tr>
          <tr>
            <td style="padding:8px 10px;color:#111827;">Invoice Total:</td>
            <td style="padding:8px 10px;color:#111827;text-align:right;font-weight:700;">${this.escapeHtml(money.format(total))}</td>
          </tr>
          <tr>
            <td style="padding:8px 10px;color:#111827;">Paid To Date:</td>
            <td style="padding:8px 10px;color:#111827;text-align:right;font-weight:700;">${this.escapeHtml(money.format(paid))}</td>
          </tr>
          <tr>
            <td style="padding:8px 10px;color:#111827;">Due Date:</td>
            <td style="padding:8px 10px;color:#111827;text-align:right;font-weight:700;">${this.escapeHtml(dueDate)}</td>
          </tr>
        </table>
        <div style="clear:both"></div>

        <div style="margin:14px 0 4px;">
          <a href="${this.escapeHtml(publicLink)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:700;">Pay Invoice Now</a>
        </div>
        <p style="margin:14px 0 0;color:#334155;">If you have questions, reply to this email and ${this.escapeHtml(business)} will help.</p>
      </div>
    `;
  }

  private buildPaidReceiptEmailHtml(detail: InvoiceDetail, business: string, paidDate: string): string {
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const logoUrl = this.resolveEmailLogoUrl(detail.businessLogoUrl || '');
    const lineRows = (detail.lineItems || [])
      .map(item => `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${this.escapeHtml(item.type === 'labor' ? 'Labor' : 'Part')}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${this.escapeHtml(item.description || '')}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">${this.escapeHtml(String(item.quantity || 0))}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">${this.escapeHtml(money.format(Number(item.unitPrice || 0)))}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right;">${this.escapeHtml(money.format(Number(item.lineTotal || 0)))}</td>
        </tr>
      `)
      .join('');

    return `
      <div style="font-family:Arial,Helvetica,sans-serif;line-height:1.45;color:#111827;max-width:900px;margin:0 auto;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
          <tr>
            <td style="vertical-align:top;">
              ${logoUrl ? `<img src="${this.escapeHtml(logoUrl)}" alt="${this.escapeHtml(business)} logo" style="max-height:72px;max-width:220px;display:block;margin:0 0 8px 0;">` : ''}
              <div style="font-size:22px;font-weight:800;">${this.escapeHtml(business)}</div>
              <div style="color:#334155;">${this.escapeHtml(String(detail.businessAddress || '').trim())}</div>
            </td>
            <td style="vertical-align:top;text-align:right;">
              <div style="font-size:30px;font-weight:800;letter-spacing:.08em;">RECEIPT</div>
              <div><strong>Invoice #:</strong> ${this.escapeHtml(detail.invoiceNumber)}</div>
              <div><strong>Paid Date:</strong> ${this.escapeHtml(paidDate)}</div>
              <div style="margin-top:6px;display:inline-block;background:#16a34a;color:#fff;padding:5px 10px;border-radius:999px;font-size:12px;font-weight:700;">PAID</div>
            </td>
          </tr>
        </table>

        <div style="margin:8px 0 14px;"><strong>Customer:</strong> ${this.escapeHtml(detail.customerName || 'Customer')}</div>

        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:10px 0 14px;">
          <thead>
            <tr>
              <th style="background:#e5e7eb;text-align:left;padding:8px;">Item</th>
              <th style="background:#e5e7eb;text-align:left;padding:8px;">Description</th>
              <th style="background:#e5e7eb;text-align:right;padding:8px;">Qty</th>
              <th style="background:#e5e7eb;text-align:right;padding:8px;">Price</th>
              <th style="background:#e5e7eb;text-align:right;padding:8px;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${lineRows || '<tr><td colspan="5" style="padding:8px;border-bottom:1px solid #e5e7eb;color:#64748b;">No line items.</td></tr>'}
          </tbody>
        </table>

        <table role="presentation" align="right" cellpadding="0" cellspacing="0" border="0" style="width:320px;max-width:100%;border:1px solid #cbd5e1;border-radius:8px;background:#f8fafc;">
          <tr>
            <td style="padding:8px;">Subtotal:</td>
            <td style="padding:8px;text-align:right;font-weight:700;">${this.escapeHtml(money.format(Number(detail.subtotal || 0)))}</td>
          </tr>
          <tr>
            <td style="padding:8px;">Tax:</td>
            <td style="padding:8px;text-align:right;font-weight:700;">${this.escapeHtml(money.format(Number(detail.taxTotal || 0)))}</td>
          </tr>
          <tr>
            <td style="padding:10px;background:#dcfce7;font-weight:800;">Total Paid:</td>
            <td style="padding:10px;background:#dcfce7;text-align:right;font-weight:800;">${this.escapeHtml(money.format(Number(detail.total || 0)))}</td>
          </tr>
        </table>
        <div style="clear:both"></div>

        <p style="margin-top:16px;color:#334155;">Thank you for your payment.</p>
      </div>
    `;
  }

  private buildPaidReceiptPrintHtml(detail: InvoiceDetail, paidDate: string): string {
    const business = String(detail.businessName || '').trim() || 'Your Company';
    const html = this.buildPaidReceiptEmailHtml(detail, business, paidDate);
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Receipt ${this.escapeHtml(detail.invoiceNumber)}</title>
    <style>
      body { margin: 24px; font-family: Arial, Helvetica, sans-serif; color: #111827; }
      @media print {
        body { margin: 10mm; }
      }
    </style>
  </head>
  <body>${html}</body>
</html>`;
  }

  private buildInvoicePrintHtml(detail: InvoiceDetail): string {
    const amountDue = this.roundCurrency(Math.max(0, Number(detail.total || 0) - Number(detail.paidAmount || 0)));
    const paymentLink = String(detail.paymentLinkUrl || '').trim()
      || this.paymentSettings.createHostedPaymentLink(detail.id, detail.invoiceNumber)
      || '';
    const publicLink = this.invoicePaymentPublicUrl(detail, paymentLink, amountDue);
    const business = String(detail.businessName || '').trim() || 'Your Company';
    const html = this.buildInvoiceEmailHtml(detail, publicLink, business, amountDue);
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Invoice ${this.escapeHtml(detail.invoiceNumber)}</title>
    <style>
      body { margin: 24px; font-family: Arial, Helvetica, sans-serif; color: #111827; }
      @media print {
        body { margin: 10mm; }
      }
    </style>
  </head>
  <body>${html}</body>
</html>`;
  }

  private displayPaidDate(detail: InvoiceDetail): string {
    const source = String(detail.paymentDate || detail.updatedAt || '').trim();
    if (!source) return new Date().toLocaleDateString('en-US');
    const parsed = new Date(source);
    if (!Number.isFinite(parsed.getTime())) return source;
    return parsed.toLocaleDateString('en-US');
  }

  private formatUsd(value: number): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
  }

  private isFinalInvoiceSendLocked(detail: InvoiceDetail): boolean {
    if (!detail || detail.documentType !== 'invoice') return false;
    const total = this.roundCurrency(Math.max(0, Number(detail.total || 0)));
    const paid = this.normalizePaidAmount(detail.paidAmount);
    const due = this.roundCurrency(Math.max(0, total - paid));
    if (paid <= 0 || due <= 0) return false;
    const sentAt = this.latestTimelineEventAt(detail, 'final invoice sent to customer');
    if (!sentAt) return false;
    const updatedAt = this.latestTimelineEventAt(detail, 'final invoice updated after send');
    return !updatedAt || sentAt >= updatedAt;
  }

  private latestTimelineEventAt(detail: InvoiceDetail, needle: string): number {
    const target = String(needle || '').trim().toLowerCase();
    if (!target) return 0;
    let latest = 0;
    for (const entry of detail.timeline || []) {
      const message = String(entry?.message || '').trim().toLowerCase();
      if (!message.includes(target)) continue;
      const stamp = Date.parse(String(entry?.createdAt || '').trim());
      if (Number.isFinite(stamp) && stamp > latest) latest = stamp;
    }
    return latest;
  }

  private normalizePaidAmount(value: unknown): number {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    return this.roundCurrency(Math.max(0, amount));
  }

  private safeText(value: unknown): string {
    return value == null ? '' : String(value).trim();
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

  private publicRouteUrl(path: string, query?: URLSearchParams): string {
    const normalizedPath = `/${String(path || '').replace(/^\/+/, '')}`;
    const base = this.publicAppBaseUrl() || (typeof window !== 'undefined' ? String(window.location.origin || '').trim() : '');
    if (!base) {
      const suffix = query && query.toString() ? `?${query.toString()}` : '';
      return `${normalizedPath}${suffix}`;
    }
    try {
      const url = new URL(normalizedPath, base);
      if (query && query.toString()) url.search = query.toString();
      return url.toString();
    } catch {
      const trimmed = base.replace(/\/+$/, '');
      const suffix = query && query.toString() ? `?${query.toString()}` : '';
      return `${trimmed}${normalizedPath}${suffix}`;
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

  private queueCustomerAddressLookup(raw: string): void {
    if (this.customerAddressSearchTimer) {
      clearTimeout(this.customerAddressSearchTimer);
      this.customerAddressSearchTimer = null;
    }
    this.customerAddressLookupSub?.unsubscribe();
    this.customerAddressSearching.set(false);
    const query = String(raw || '').trim();
    if (query.length < 4) {
      this.customerAddressSuggestions.set([]);
      this.customerAddressNoMatches.set(false);
      return;
    }
    this.customerAddressSearchTimer = setTimeout(() => this.lookupCustomerAddressSuggestions(query), 320);
  }

  private lookupCustomerAddressSuggestions(query: string): void {
    this.customerAddressSearching.set(true);
    this.customerAddressNoMatches.set(false);
    this.customerAddressLookupSub = this.addressLookup.search(query, 6, 'us')
      .pipe(finalize(() => this.customerAddressSearching.set(false)))
      .subscribe({
        next: suggestions => {
          this.customerAddressSuggestions.set(suggestions);
          this.customerAddressNoMatches.set(query.length >= 4 && !suggestions.length);
        },
        error: () => {
          this.customerAddressSuggestions.set([]);
          this.customerAddressNoMatches.set(true);
        }
      });
  }

  private queueBusinessAddressLookup(raw: string): void {
    if (this.businessAddressSearchTimer) {
      clearTimeout(this.businessAddressSearchTimer);
      this.businessAddressSearchTimer = null;
    }
    this.businessAddressLookupSub?.unsubscribe();
    this.businessAddressSearching.set(false);
    const query = String(raw || '').trim();
    if (query.length < 4) {
      this.businessAddressSuggestions.set([]);
      this.businessAddressNoMatches.set(false);
      return;
    }
    this.businessAddressSearchTimer = setTimeout(() => this.lookupBusinessAddressSuggestions(query), 320);
  }

  private lookupBusinessAddressSuggestions(query: string): void {
    this.businessAddressSearching.set(true);
    this.businessAddressNoMatches.set(false);
    this.businessAddressLookupSub = this.addressLookup.search(query, 6, 'us')
      .pipe(finalize(() => this.businessAddressSearching.set(false)))
      .subscribe({
        next: suggestions => {
          this.businessAddressSuggestions.set(suggestions);
          this.businessAddressNoMatches.set(query.length >= 4 && !suggestions.length);
        },
        error: () => {
          this.businessAddressSuggestions.set([]);
          this.businessAddressNoMatches.set(true);
        }
      });
  }

  private clearStatus(): void {
    this.status.set('');
    this.statusTone.set('neutral');
  }

  private setStatus(message: string, tone: StatusTone = 'neutral'): void {
    this.status.set(message);
    this.statusTone.set(tone);
    void this.presentStatusToast(message, tone);
  }

  private setStatusAfterModalClose(message: string, tone: StatusTone = 'neutral'): void {
    const value = String(message || '').trim();
    if (!value) return;
    setTimeout(() => this.setStatus(value, tone), 220);
  }

  private async presentStatusToast(message: string, tone: StatusTone): Promise<void> {
    const value = String(message || '').trim();
    if (!value) return;
    const key = `${tone}:${value}`.toLowerCase();
    const now = Date.now();
    if (this.lastToastKey === key && now - this.lastToastAt < 1200) return;
    this.lastToastKey = key;
    this.lastToastAt = now;

    const color = tone === 'error' ? 'danger' : tone === 'success' ? 'success' : 'medium';
    const toast = await this.toastController.create({
      message: value,
      color,
      duration: 1800,
      position: 'top'
    });
    await toast.present();
  }

  private async notifyInvoiceBuildNeeded(previousStage: InvoiceStage, saved: InvoiceDetail): Promise<void> {
    if (saved.documentType !== 'quote') return;
    if (previousStage === 'accepted' || saved.stage !== 'accepted') return;

    const user = this.auth.user();
    if (!user) return;
    try {
      await firstValueFrom(
        this.notificationsApi.createMention({
          targetUserId: user.id || undefined,
          targetEmail: user.email || undefined,
          targetDisplayName: user.displayName || undefined,
          title: `Quote ${saved.invoiceNumber} accepted`,
          message: `${saved.customerName} accepted this quote. Build and send an invoice next.`,
          route: `/quotes/${encodeURIComponent(saved.id || saved.invoiceNumber)}`,
          entityType: 'quote',
          entityId: saved.id,
          metadata: {
            quoteId: saved.id,
            quoteNumber: saved.invoiceNumber,
            customerId: saved.customerId || '',
            customerName: saved.customerName
          }
        })
      );
    } catch {
      // Notification failure should not block save.
    }
  }

  private documentTypeLabelFor(type: InvoiceDocumentType): string {
    return type === 'quote' ? 'Quote' : 'Invoice';
  }
}
