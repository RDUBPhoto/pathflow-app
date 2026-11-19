import { ToastController, UiModal } from '../../ui/overlays';
import { UiIcon } from '../../ui/icons';
import { CommonModule, CurrencyPipe, DatePipe } from '@angular/common';
import { Component, HostListener, OnDestroy, computed, effect, inject, signal, untracked, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription, finalize, firstValueFrom } from 'rxjs';
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
import { AppNotification, NotificationsApiService } from '../../services/notifications-api.service';
import { EmailApiService } from '../../services/email-api.service';
import { SmsApiService } from '../../services/sms-api.service';
import { TenantContextService } from '../../services/tenant-context.service';
import { PaymentRefundApiService, PaymentRefundPayload, PaymentRefundPreview, PaymentRefundResponse } from '../../services/payment-refund-api.service';
import { AppSettingsApiService } from '../../services/app-settings-api.service';
import { InventoryApiService, InventoryItem } from '../../services/inventory-api.service';
import { InvoiceResponseApiService } from '../../services/invoice-response-api.service';
import { PurchaseOrder, PurchaseOrderLine, PurchaseOrdersApiService } from '../../services/purchase-orders-api.service';
import { CustomerPortalApi } from '../../services/customer-portal-api.service';
import { QuoteResponseApiService } from '../../services/quote-response-api.service';
import { environment } from '../../../environments/environment';

type StatusTone = 'neutral' | 'success' | 'error';
const BUSINESS_LABOR_RATES_SETTING_KEY = 'business.labor.rates';
type RefundAllocation = {
  provider: string;
  originalTransactionId: string;
  accountNumber: string;
  refundableAmount: number;
  alreadyReversed?: number;
};
type LaborRateOption = {
  id: string;
  name: string;
  price: number;
  taxable: boolean;
};
type LineItemSearchOption = {
  id: string;
  label: string;
  meta: string;
  type: InvoiceLineType;
  relatedInventoryItemId?: string;
  code: string;
  unitPrice: number;
  taxRate: number;
  partStatus?: InvoicePartStatus;
};

type LinkedPurchaseOrderRow = {
  order: PurchaseOrder;
  line: PurchaseOrderLine;
};

@Component({
  selector: 'app-invoice-detail',
  standalone: true,
  imports: [
    CommonModule,
    CurrencyPipe,
    DatePipe,
    UiModal,
    UiIcon,
    RouterLink,
    PageBackButtonComponent,
    CompanySwitcherComponent,
    UserMenuComponent
  ],
  templateUrl: './invoice-detail.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./invoice-detail.component.scss']
})
export default class InvoiceDetailComponent implements OnDestroy {
  readonly lineItemsPageSize = 10;
  private readonly quoteStageOptionsList: InvoiceBoardStage[] = ['draft', 'sent', 'accepted', 'declined'];
  private readonly invoiceStageOptionsList: InvoiceBoardStage[] = ['draft', 'sent', 'accepted', 'completed'];
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly invoicesData = inject(InvoicesDataService);
  readonly documentSyncError = this.invoicesData.documentSyncError;
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
  private readonly settingsApi = inject(AppSettingsApiService);
  private readonly inventoryApi = inject(InventoryApiService);
  private readonly invoiceResponseApi = inject(InvoiceResponseApiService);
  private readonly purchaseOrdersApi = inject(PurchaseOrdersApiService);
  private readonly quoteResponseApi = inject(QuoteResponseApiService);
  private readonly customerPortal = inject(CustomerPortalApi);
  private readonly toastController = inject(ToastController);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly status = signal('');
  readonly statusTone = signal<StatusTone>('neutral');
  readonly lineItemsPage = signal(1);
  readonly inventoryItems = signal<InventoryItem[]>([]);
  readonly partPickerOpen = signal(false);
  readonly partPickerQuery = signal('');
  readonly purchaseOrders = signal<PurchaseOrder[]>([]);
  readonly laborRates = signal<LaborRateOption[]>([]);
  readonly lineItemSearchQuery = signal<Record<string, string>>({});
  readonly activeLineItemSearchId = signal('');
  readonly sendingInvoice = signal(false);
  readonly refundingCustomer = signal(false);
  readonly sendInvoiceModalOpen = signal(false);
  readonly invoiceActionsMenuOpen = signal(false);
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
  private lineItemSourcesLoaded = false;
  private loadingLineItemSources = false;

  readonly invoice = signal<InvoiceDetail | null>(null);
  private readonly baselineSnapshot = signal('');
  readonly partStatusOptions: Array<{ value: InvoicePartStatus; label: string }> = [
    { value: 'out-of-stock', label: 'Out of stock' },
    { value: 'in-stock', label: 'In-stock' },
    { value: 'ordered', label: 'Ordered' },
    { value: 'backordered', label: 'Backordered' },
    { value: 'received', label: 'Received' }
  ];

  readonly paymentAvailability = this.paymentSettings.paymentLinkAvailability;
  readonly portalOpen = signal(false);
  readonly portalBusy = signal(false);
  readonly portalUrl = signal('');
  readonly portalStatus = signal('');
  readonly portalFeedback = signal('');
  readonly portalError = signal('');
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
    const total = this.roundCurrency(Math.max(0, subtotal + taxTotal - Number(detail?.returnCreditAmount || 0)));
    return { subtotal, taxTotal, total };
  });
  readonly paidAmount = computed(() => {
    return this.normalizePaidAmount(this.invoice()?.paidAmount);
  });
  readonly amountDue = computed(() => this.roundCurrency(Math.max(0, this.totals().total - this.paidAmount())));
  readonly overpaymentAmount = computed(() => this.roundCurrency(Math.max(0, this.paidAmount() - this.totals().total)));
  readonly paylynxRefunds = computed(() => {
    const detail = this.invoice();
    return detail ? this.buildRefundAllocations(detail, this.paidAmount(), 'paylynx') : [];
  });
  readonly paylynxReturn = signal<RefundAllocation | null>(null);
  readonly returnPreview = signal<PaymentRefundPreview | null>(null);
  readonly loadingReturn = signal(false);
  readonly returnError = signal('');
  readonly returnResult = signal('');
  readonly returnNeedsReview = signal(false);
  readonly returnMode = signal<'payment' | 'credit'>('payment');
  readonly returnAmount = signal('');
  readonly returnFee = signal('');
  readonly returnReason = signal('');
  readonly returnNetAmount = computed(() => {
    const amount = this.returnPreview()?.operation === 'void' ? this.returnPreview()?.originalAmount || 0
      : Number(this.returnAmount());
    const fee = this.returnMode() === 'credit' && this.returnPreview()?.operation === 'refund' ? Number(this.returnFee()) : 0;
    return this.roundCurrency(amount - fee);
  });
  readonly canSubmitReturn = computed(() => {
    const preview = this.returnPreview();
    if (!preview || this.refundingCustomer() || this.returnNeedsReview() || this.hasChanges() || this.returnNetAmount() <= 0) return false;
    if (preview.operation === 'refund' && (!/^\d+(\.\d{1,2})?$/.test(this.returnAmount()) ||
        Number(this.returnAmount()) > preview.refundableAmount)) return false;
    if (this.returnMode() === 'credit' && (!this.returnReason().trim() || this.returnNetAmount() > preview.invoiceTotal ||
        (this.returnFee() && !/^\d+(\.\d{1,2})?$/.test(this.returnFee())))) return false;
    return preview.operation === 'refund' || preview.originalAmount === preview.refundableAmount;
  });
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
  readonly partPickerResults = computed(() => {
    const query = this.partPickerQuery().trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    return this.inventoryItems()
      .filter(item => {
        if (!terms.length) return true;
        const haystack = [
          this.inventoryName(item),
          this.inventorySku(item),
          this.inventoryVendor(item)
        ].join(' ').toLowerCase();
        return terms.every(term => haystack.includes(term));
      })
      .slice(0, 60);
  });
  readonly orderedPartLines = computed(() =>
    (this.lineItems() || []).filter(line => line.type === 'part' && this.normalizePartStatus(line.partStatus) === 'ordered')
  );
  readonly linkedPurchaseOrderRows = computed<LinkedPurchaseOrderRow[]>(() => {
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice') return [];
    const invoiceId = this.safeText(detail.id);
    const jobNumber = this.safeText(detail.jobNumber);
    const lineItemIds = new Set(
      (detail.lineItems || [])
        .map(line => this.safeText(line.id))
        .filter(Boolean)
    );
    const jobPartIds = new Set(
      (detail.lineItems || [])
        .map(line => this.safeText(line.jobPartId))
        .filter(Boolean)
    );
    const seen = new Set<string>();
    const rows: LinkedPurchaseOrderRow[] = [];
    for (const order of this.purchaseOrders()) {
      for (const line of order.lines || []) {
        const key = `${order.id}:${line.lineId || line.needId || line.partName}`;
        if (seen.has(key)) continue;
        if (
          (invoiceId && this.safeText(line.relatedInvoiceId) === invoiceId)
          || (line.relatedInvoiceLineItemId && lineItemIds.has(this.safeText(line.relatedInvoiceLineItemId)))
          || (line.needId && jobPartIds.has(this.safeText(line.needId)))
          || (jobNumber && this.safeText(line.jobNumber) === jobNumber)
        ) {
          seen.add(key);
          rows.push({ order, line });
        }
      }
    }
    return rows;
  });

  constructor() {
    void this.ensureLineItemSourcesLoaded();

    effect(() => {
      this.invoicesData.invoiceDetails();
      const id = String(this.route.snapshot.paramMap.get('id') || '').trim();
      if (id) untracked(() => this.resolveInvoiceFromStore(id));
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
    void this.ensureLineItemSourcesLoaded();
    if (type === 'part') {
      this.openPartPicker();
      return;
    }
    this.addBlankLineItem(type);
  }

  openPartPicker(): void {
    void this.ensureLineItemSourcesLoaded();
    this.partPickerQuery.set('');
    this.partPickerOpen.set(true);
  }

  closePartPicker(): void {
    this.partPickerOpen.set(false);
    this.partPickerQuery.set('');
  }

  setPartPickerQuery(value: string): void {
    this.partPickerQuery.set(String(value || ''));
  }

  addInventoryPartFromPicker(item: InventoryItem): void {
    const price = this.roundCurrency(this.safeNumber((item as InventoryItem & Record<string, unknown>).price, this.safeNumber(item.unitCost, this.safeNumber(item.cost, 0))));
    const line = this.recalculateLine({
      id: `li-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: 'part',
      partStatus: 'out-of-stock',
      relatedInventoryItemId: String(item.id || '').trim(),
      code: this.inventorySku(item),
      description: this.inventoryName(item) || 'Part',
      quantity: 1,
      unitPrice: price,
      taxRate: 0,
      lineSubtotal: 0,
      taxAmount: 0,
      lineTotal: 0
    });
    this.appendLineItem(line);
    this.closePartPicker();
  }

  addCustomPartFromPicker(): void {
    this.addBlankLineItem('part');
    this.closePartPicker();
  }

  private addBlankLineItem(type: InvoiceLineType): void {
    this.invoice.update(current => {
      if (!current) return current;
      const line: InvoiceLineItem = this.recalculateLine({
        id: `li-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        type,
        partStatus: type === 'part' ? 'out-of-stock' : undefined,
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

  private appendLineItem(line: InvoiceLineItem): void {
    this.invoice.update(current => {
      if (!current) return current;
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
    this.lineItemSearchQuery.update(current => {
      if (!Object.prototype.hasOwnProperty.call(current, id)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (this.activeLineItemSearchId() === id) {
      this.activeLineItemSearchId.set('');
    }
    this.clearStatus();
    this.lineItemsPage.update(value => Math.max(1, Math.min(value, this.lineItemsTotalPages())));
  }

  lineItemSearchValue(line: InvoiceLineItem): string {
    const search = this.lineItemSearchQuery()[line.id];
    if (typeof search === 'string' && search.length) return search;
    return String(line.description || '');
  }

  onLineItemSearchFocus(lineId: string): void {
    const id = String(lineId || '').trim();
    if (!id) return;
    this.activeLineItemSearchId.set(id);
  }

  onLineItemSearchInput(line: InvoiceLineItem, rawValue: string): void {
    const value = String(rawValue || '');
    this.lineItemSearchQuery.update(current => ({ ...current, [line.id]: value }));
    this.activeLineItemSearchId.set(line.id);
    this.updateLineItemField(line.id, 'description', value);
  }

  onLineItemSearchBlur(lineId: string): void {
    const id = String(lineId || '').trim();
    if (!id) return;
    setTimeout(() => {
      if (this.activeLineItemSearchId() === id) {
        this.activeLineItemSearchId.set('');
      }
    }, 120);
  }

  isLineItemSearchOpen(line: InvoiceLineItem): boolean {
    return this.activeLineItemSearchId() === line.id;
  }

  lineItemSearchOptions(line: InvoiceLineItem): LineItemSearchOption[] {
    const rawQuery = this.lineItemSearchValue(line).trim().toLowerCase();
    const terms = rawQuery.split(/\s+/).filter(Boolean);
    const matchesQuery = (value: string): boolean => {
      if (!terms.length) return true;
      const haystack = String(value || '').toLowerCase();
      return terms.every(term => haystack.includes(term));
    };
    const options = line.type === 'part'
      ? this.inventoryItems()
          .map(item => {
            const name = this.inventoryName(item);
            const sku = this.inventorySku(item);
            const vendor = this.inventoryVendor(item);
            const price = this.roundCurrency(this.safeNumber((item as InventoryItem & Record<string, unknown>).price, this.safeNumber(item.unitCost, this.safeNumber(item.cost, 0))));
            const unitCost = this.roundCurrency(this.safeNumber(item.unitCost, this.safeNumber(item.cost, 0)));
            const meta = [sku || 'No SKU', vendor || 'No vendor', `${this.formatUsd(price)} sell`, `${this.formatUsd(unitCost)} cost`].join(' · ');
            return {
              id: String(item.id || '').trim() || `part-${sku}-${name}`.toLowerCase(),
              label: name || 'Part',
              meta,
              type: 'part' as const,
              relatedInventoryItemId: String(item.id || '').trim(),
              code: sku,
              unitPrice: price,
              taxRate: this.safeNumber(line.taxRate, 0),
              partStatus: 'out-of-stock' as InvoicePartStatus
            };
          })
      : this.laborRates()
          .map(rate => ({
            id: String(rate.id || '').trim() || `labor-${rate.name}`.toLowerCase(),
            label: String(rate.name || '').trim() || 'Labor',
            meta: `${this.formatUsd(rate.price)} · ${rate.taxable ? 'Taxable' : 'Non-taxable'}`,
            type: 'labor' as const,
            code: String(rate.id || '').trim(),
            unitPrice: this.safeNumber(rate.price, 0),
            taxRate: rate.taxable ? this.safeNumber(line.taxRate, 0) : 0
          }));

    return options
      .filter(option => matchesQuery(`${option.label} ${option.code} ${option.meta}`))
      .slice(0, 10);
  }

  selectLineItemSearchOption(line: InvoiceLineItem, option: LineItemSearchOption): void {
    this.lineItemSearchQuery.update(current => ({ ...current, [line.id]: option.label }));
    this.patchLineItem(line.id, {
      type: option.type,
      code: option.code,
      description: option.label,
      relatedInventoryItemId: option.type === 'part' ? (option.relatedInventoryItemId || '') : '',
      unitPrice: option.unitPrice,
      taxRate: option.taxRate,
      partStatus: option.type === 'part' ? (option.partStatus || 'out-of-stock') : undefined
    });
    this.activeLineItemSearchId.set('');
  }

  updateLineItemField(lineId: string, field: keyof InvoiceLineItem, rawValue: string): void {
    const id = String(lineId || '').trim();
    if (!id) return;

    this.invoice.update(current => {
      if (!current) return current;
      const actor = String(this.auth.user()?.displayName || this.auth.user()?.email || 'Staff').trim();
      let statusTimelineMessage = '';
      let trackingTimelineMessage = '';
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
          const prev = this.normalizePartStatus(nextLine.partStatus);
          const nextStatus = this.normalizePartStatus(rawValue);
          nextLine.partStatus = nextStatus;
          if (prev !== nextStatus) {
            const label = this.safeText(nextLine.description) || this.safeText(nextLine.code) || 'Part';
            statusTimelineMessage = `${label}: status updated from "${this.partStatusLabel(prev)}" to "${this.partStatusLabel(nextStatus)}".`;
          }
        } else if (field === 'trackingNumber') {
          const prevTracking = this.safeText(nextLine.trackingNumber);
          const nextTracking = String(rawValue || '').trim();
          nextLine.trackingNumber = nextTracking;
          if (prevTracking !== nextTracking) {
            const label = this.safeText(nextLine.description) || this.safeText(nextLine.code) || 'Part';
            if (nextTracking) {
              trackingTimelineMessage = `${label}: tracking number set to "${nextTracking}".`;
            } else {
              trackingTimelineMessage = `${label}: tracking number cleared.`;
            }
          }
        } else if (field === 'code' || field === 'description') {
          (nextLine[field] as string) = String(rawValue || '');
        }

        return this.recalculateLine(nextLine);
      });

      let nextTimeline = current.timeline || [];
      if (statusTimelineMessage) {
        nextTimeline = [
          ...nextTimeline,
          {
            id: `timeline-${current.id}-part-status-${Date.now()}`,
            createdAt: new Date().toISOString(),
            message: statusTimelineMessage,
            actorType: 'system',
            createdBy: actor
          }
        ];
      }
      if (trackingTimelineMessage) {
        nextTimeline = [
          ...nextTimeline,
          {
            id: `timeline-${current.id}-part-tracking-${Date.now()}`,
            createdAt: new Date().toISOString(),
            message: trackingTimelineMessage,
            actorType: 'system',
            createdBy: actor
          }
        ];
      }

      return {
        ...current,
        lineItems: nextLines,
        timeline: nextTimeline,
        updatedAt: new Date().toISOString()
      };
    });
    this.clearStatus();
  }

  async save(): Promise<void> {
    const current = this.invoice();
    if (!current || !this.canSave()) return;
    const stored = this.invoicesData.getInvoiceById(current.id);
    if (stored && this.snapshot(stored) !== this.baselineSnapshot()) {
      this.setStatus('Another session changed this document. Review the saved version before applying your edits.', 'error');
      return;
    }

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
        next = this.withCurrentPaymentLink(next);
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

      if (!await this.syncPaidInvoicePartsIfNeeded(previousStage, next)) {
        this.setStatus('Could not record payment. Check the published balance and try again.', 'error');
        return;
      }
      const saved = this.invoicesData.saveInvoice(next);
      if (previousStage !== saved.stage) {
        await this.markStaleWorkflowNotificationsRead(saved);
      }
      await this.notifyInvoiceBuildNeeded(previousStage, saved);
      const autoCompleteOutcome = await this.autoCompleteWorkItemOnInvoiceCompleted(previousStage, saved);
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

  invoiceJobDetailQueryParams(detail: InvoiceDetail): Record<string, string> {
    const params: Record<string, string> = {};
    const jobNumber = this.safeText(detail.jobNumber);
    if (jobNumber) params['jobNumber'] = jobNumber;
    if (detail.id) params['invoiceId'] = detail.id;
    if (detail.lineItems?.[0]?.id) params['invoiceLineItemId'] = detail.lineItems[0].id;
    return params;
  }

  poJobDetailQueryParams(row: LinkedPurchaseOrderRow): Record<string, string> {
    const params: Record<string, string> = {};
    const jobId = this.safeText(row.line.jobId);
    const jobNumber = this.safeText(row.line.jobNumber);
    const needId = this.safeText(row.line.needId);
    const invoiceId = this.safeText(row.line.relatedInvoiceId);
    const invoiceLineItemId = this.safeText(row.line.relatedInvoiceLineItemId);
    if (jobId) params['jobId'] = jobId;
    if (jobNumber) params['jobNumber'] = jobNumber;
    if (needId) params['needId'] = needId;
    if (invoiceId) params['invoiceId'] = invoiceId;
    if (invoiceLineItemId) params['invoiceLineItemId'] = invoiceLineItemId;
    return params;
  }

  poReceivedProgress(line: PurchaseOrderLine): string {
    const received = this.safeNumber(line.qtyReceived, 0);
    const ordered = Math.max(this.safeNumber(line.qty, 0), this.safeNumber(line.qtyNeeded, 0), received);
    return `${this.formatQuantity(received)} / ${this.formatQuantity(ordered)}`;
  }

  formatQuantity(value: unknown): string {
    const numeric = this.safeNumber(value, 0);
    if (Math.abs(numeric - Math.round(numeric)) < 0.001) return String(Math.round(numeric));
    return numeric.toFixed(2);
  }

  trackingUrl(value: unknown): string {
    const tracking = this.safeText(value);
    return tracking ? `https://www.google.com/search?q=${encodeURIComponent(`${tracking} tracking`)}` : '';
  }

  formatDateOnly(value: unknown): string {
    const text = this.safeText(value);
    if (!text) return 'N/A';
    const date = new Date(text);
    if (Number.isNaN(date.getTime())) return text;
    return date.toLocaleDateString();
  }

  async createInvoiceFromQuote(): Promise<void> {
    const current = this.invoice();
    if (!current || current.documentType !== 'quote' || current.stage !== 'accepted') return;
    const created = this.invoicesData.createInvoiceFromQuote(current.id);
    if (!created) {
      this.setStatus('Could not create invoice from quote.', 'error');
      return;
    }
    await this.markStaleWorkflowNotificationsRead(current);
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
    this.sendInvoiceViaSms.set(hasSms);
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

  openCustomerPortal(): void {
    this.portalOpen.set(true);
    this.portalStatus.set('');
    this.portalUrl.set('');
    void this.updatePortalAccess('issue');
  }

  async updatePortalAccess(action: 'issue' | 'rotate' | 'revoke'): Promise<void> {
    const detail = this.invoice();
    if (!detail || this.portalBusy()) return;
    this.portalBusy.set(true);
    this.portalError.set('');
    this.portalFeedback.set('');
    try {
      const access = await this.customerPortal.manage(detail.id, action);
      this.portalUrl.set(access.path ? this.publicRouteUrl(access.path) : '');
      this.portalStatus.set(access.status);
      if (action === 'rotate') this.portalFeedback.set('New link created.');
      if (action === 'revoke') this.portalFeedback.set('Link revoked.');
    } catch (error) {
      this.portalError.set(this.extractSendFailureReason(error) || 'Could not update portal access.');
    } finally {
      this.portalBusy.set(false);
    }
  }

  async copyCustomerPortal(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.portalUrl());
      this.portalFeedback.set('Link copied.');
      this.portalError.set('');
    } catch {
      this.portalError.set('Could not copy automatically. Select and copy the URL.');
    }
  }

  async sendCustomerPortal(channel: 'email' | 'sms'): Promise<void> {
    const detail = this.invoice();
    const url = this.portalUrl();
    const target = channel === 'email' ? this.invoiceEmailTarget() : this.invoiceSmsTarget();
    if (!detail || !url || !target || this.portalBusy()) return;
    this.portalBusy.set(true);
    this.portalError.set('');
    this.portalFeedback.set('');
    try {
      const content = {
        customerId: detail.customerId || '', customerName: detail.customerName,
        to: target, message: `${detail.businessName || 'Your shop'}: Open your service visit: ${url}`
      };
      if (channel === 'email') {
        await firstValueFrom(this.emailApi.sendToCustomer({ ...content, subject: 'Your service visit' }));
      } else {
        await firstValueFrom(this.smsApi.sendToCustomer(content));
      }
      this.portalFeedback.set(channel === 'email' ? 'Link sent by email.' : 'Link sent by SMS.');
    } catch (error) {
      this.portalError.set(this.extractSendFailureReason(error) || 'Could not send the portal link.');
    } finally {
      this.portalBusy.set(false);
    }
  }

  async sendInvoiceForPayment(options?: { email: boolean; sms: boolean }): Promise<void> {
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice' || this.sendingInvoice()) return;

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
      const checkout = this.withCurrentPaymentLink(detail);
      const paymentLink = checkout.paymentLinkUrl || '';
      if (!paymentLink) {
        this.sendInvoiceModalError.set('Payment link unavailable. Connect payment provider or save invoice with a payment link.');
        this.setStatus('Payment link unavailable. Save invoice or connect payment provider, then try again.', 'error');
        return;
      }
      await this.publishInvoicePaymentSnapshotUrl(checkout, paymentLink, amountDue, true);
      const publicLink = this.publicRouteUrl(await this.customerPortal.issueLink(detail.id));
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
            message: `${business}: ${detail.invoiceNumber} amount due ${this.formatUsd(amountDue)}. View and pay: ${publicLink}`
            })
          )
        });
      }

      const settled = await Promise.allSettled(sends.map(row => row.promise));
      const results = sends.map((row, index) => ({ channel: row.channel, result: settled[index] }));
      const emailSuccess = !wantsEmail || results.some(row => row.channel === 'email' && row.result.status === 'fulfilled');
      const smsSuccess = !wantsSms || results.some(row => row.channel === 'sms' && row.result.status === 'fulfilled');
      const emailFailureReason = results
        .filter(row => row.channel === 'email' && row.result.status === 'rejected')
        .map(row => this.extractSendFailureReason((row.result as PromiseRejectedResult).reason))
        .find(Boolean) || '';
      const smsFailureReason = results
        .filter(row => row.channel === 'sms' && row.result.status === 'rejected')
        .map(row => this.extractSendFailureReason((row.result as PromiseRejectedResult).reason))
        .find(Boolean) || '';
      const anySuccess = emailSuccess || smsSuccess;

      if (!anySuccess) {
        const message = this.composeDeliveryFailureMessage('Invoice', wantsEmail, wantsSms, emailFailureReason, smsFailureReason);
        this.sendInvoiceModalError.set(message);
        this.setStatus(message, 'error');
        return;
      }

      const deliveryTimeline: InvoiceTimelineEntry[] = [
        ...(detail.timeline || [])
      ];
      if (emailSuccess) {
        deliveryTimeline.push({
          id: `timeline-${detail.id}-email-sent-${Date.now()}`,
          createdAt: new Date().toISOString(),
          message: 'Invoice sent to customer by email.',
          actorType: 'system',
          createdBy: String(this.auth.user()?.displayName || this.auth.user()?.email || 'Staff').trim()
        });
      }
      if (smsSuccess) {
        deliveryTimeline.push({
          id: `timeline-${detail.id}-sms-sent-${Date.now()}`,
          createdAt: new Date().toISOString(),
          message: 'Invoice sent to customer by SMS.',
          actorType: 'system',
          createdBy: String(this.auth.user()?.displayName || this.auth.user()?.email || 'Staff').trim()
        });
      }

      const sent = this.invoicesData.saveInvoice({
        ...detail,
        includePaymentLink: true,
        paymentProviderKey: checkout.paymentProviderKey,
        paymentLinkUrl: paymentLink,
        stage: 'sent',
        timeline: this.isFinalInvoiceMode()
          ? [
              ...deliveryTimeline,
              {
                id: `timeline-${detail.id}-final-sent-${Date.now()}`,
                createdAt: new Date().toISOString(),
                message: 'Final invoice sent to customer.',
                actorType: 'system',
                createdBy: String(this.auth.user()?.displayName || this.auth.user()?.email || 'Staff').trim()
              }
            ]
          : deliveryTimeline
      });
      this.invoice.set(sent);
      this.baselineSnapshot.set(this.snapshot(sent));
      this.sendInvoiceModalError.set('');
      this.sendInvoiceModalOpen.set(false);
      await this.markStaleWorkflowNotificationsRead(sent);

      let successMessage = '';
      let successTone: StatusTone = 'success';
      if (wantsEmail && wantsSms) {
        if (emailSuccess && smsSuccess) {
          successMessage = 'Invoice sent by email and SMS.';
          successTone = 'success';
        } else if (emailSuccess) {
          successMessage = `Invoice sent by email. SMS failed${smsFailureReason ? `: ${smsFailureReason}` : '.'}`;
          successTone = 'neutral';
        } else if (smsSuccess) {
          successMessage = `Invoice sent by SMS. Email failed${emailFailureReason ? `: ${emailFailureReason}` : '.'}`;
          successTone = 'neutral';
        } else {
          successMessage = this.composeDeliveryFailureMessage('Invoice', wantsEmail, wantsSms, emailFailureReason, smsFailureReason);
          successTone = 'error';
        }
      } else if (wantsEmail) {
        successMessage = emailSuccess ? 'Invoice sent by email.' : `Invoice email failed${emailFailureReason ? `: ${emailFailureReason}` : '.'}`;
        successTone = emailSuccess ? 'success' : 'error';
      } else if (wantsSms) {
        successMessage = smsSuccess ? 'Invoice sent by SMS.' : `Invoice SMS failed${smsFailureReason ? `: ${smsFailureReason}` : '.'}`;
        successTone = smsSuccess ? 'success' : 'error';
      } else {
        successMessage = 'Pick at least one delivery channel.';
        successTone = 'error';
      }
      this.setStatusAfterModalClose(successMessage, successTone);
    } catch (error) {
      const reason = this.extractSendFailureReason(error);
      const message = reason ? `Could not send invoice: ${reason}.` : 'Could not send invoice.';
      this.sendInvoiceModalError.set(message);
      this.setStatus(message, 'error');
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
      const publicToken = this.publicToken();
      await this.publishQuoteSnapshot(detail, publicToken);
      const viewUrl = this.publicRouteUrl(await this.customerPortal.issueLink(detail.id));
      const plainMessage = `Hi ${detail.customerName || 'Customer'}, your quote ${quoteNumber} is ready. Review it here: ${viewUrl}`;
      const html = this.buildQuoteEmailHtml(detail, business, viewUrl);

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
              message: `${business}: Quote ${quoteNumber} is ready. Review and respond: ${viewUrl}`
            })
          )
        });
      }

      const settled = await Promise.allSettled(sends.map(row => row.promise));
      const results = sends.map((row, index) => ({ channel: row.channel, result: settled[index] }));
      const emailSuccess = !wantsEmail || results.some(row => row.channel === 'email' && row.result.status === 'fulfilled');
      const smsSuccess = !wantsSms || results.some(row => row.channel === 'sms' && row.result.status === 'fulfilled');
      const emailFailureReason = results
        .filter(row => row.channel === 'email' && row.result.status === 'rejected')
        .map(row => this.extractSendFailureReason((row.result as PromiseRejectedResult).reason))
        .find(Boolean) || '';
      const smsFailureReason = results
        .filter(row => row.channel === 'sms' && row.result.status === 'rejected')
        .map(row => this.extractSendFailureReason((row.result as PromiseRejectedResult).reason))
        .find(Boolean) || '';
      const anySuccess = emailSuccess || smsSuccess;

      if (!anySuccess) {
        this.setStatus(this.composeDeliveryFailureMessage('Quote', wantsEmail, wantsSms, emailFailureReason, smsFailureReason), 'error');
        return;
      }

      const deliveryTimeline: InvoiceTimelineEntry[] = [
        ...(detail.timeline || [])
      ];
      if (emailSuccess) {
        deliveryTimeline.push({
          id: `timeline-${detail.id}-email-sent-${Date.now()}`,
          createdAt: new Date().toISOString(),
          message: 'Quote sent to customer by email.',
          actorType: 'system',
          createdBy: String(this.auth.user()?.displayName || this.auth.user()?.email || 'Staff').trim()
        });
      }
      if (smsSuccess) {
        deliveryTimeline.push({
          id: `timeline-${detail.id}-sms-sent-${Date.now()}`,
          createdAt: new Date().toISOString(),
          message: 'Quote sent to customer by SMS.',
          actorType: 'system',
          createdBy: String(this.auth.user()?.displayName || this.auth.user()?.email || 'Staff').trim()
        });
      }

      const sent = this.invoicesData.saveInvoice({
        ...detail,
        stage: 'sent',
        timeline: deliveryTimeline
      });
      this.invoice.set(sent);
      this.baselineSnapshot.set(this.snapshot(sent));
      await this.markStaleWorkflowNotificationsRead(sent);

      if (wantsEmail && wantsSms) {
        if (emailSuccess && smsSuccess) this.setStatus('Quote sent by email and SMS.', 'success');
        else if (emailSuccess) this.setStatus(`Quote sent by email. SMS failed${smsFailureReason ? `: ${smsFailureReason}` : '.'}`, 'neutral');
        else if (smsSuccess) this.setStatus(`Quote sent by SMS. Email failed${emailFailureReason ? `: ${emailFailureReason}` : '.'}`, 'neutral');
      } else if (wantsEmail) {
        this.setStatus(emailSuccess ? 'Quote sent by email.' : `Quote email failed${emailFailureReason ? `: ${emailFailureReason}` : '.'}`, emailSuccess ? 'success' : 'error');
      } else if (wantsSms) {
        this.setStatus(smsSuccess ? 'Quote sent by SMS.' : `Quote SMS failed${smsFailureReason ? `: ${smsFailureReason}` : '.'}`, smsSuccess ? 'success' : 'error');
      }
    } catch (error) {
      const reason = this.extractSendFailureReason(error);
      this.setStatus(reason ? `Could not send quote: ${reason}.` : 'Could not send quote.', 'error');
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

  openPaylynxCharge(): void {
    this.closeInvoiceActionsMenu();
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice' || detail.stage === 'draft' || this.hasChanges() || this.amountDue() <= 0) return;
    void this.router.navigate(['/invoices', detail.id, 'charge'], { queryParams: { tenantId: this.tenantContext.tenantId() } });
  }

  openPaylynxReturn(allocation: RefundAllocation): void {
    this.closeInvoiceActionsMenu();
    if (!this.invoice() || this.refundingCustomer() || this.hasChanges()) return;
    this.paylynxReturn.set(allocation);
    this.returnResult.set('');
    this.returnMode.set('payment');
    this.returnFee.set('');
    this.returnReason.set('');
    this.returnAmount.set('');
    this.returnNeedsReview.set(false);
    void this.loadPaylynxReturn();
  }

  closePaylynxReturn(): void {
    if (!this.refundingCustomer()) this.paylynxReturn.set(null);
  }

  async loadPaylynxReturn(): Promise<void> {
    const detail = this.invoice();
    const allocation = this.paylynxReturn();
    if (!detail || !allocation || this.loadingReturn()) return;
    this.loadingReturn.set(true);
    this.returnError.set('');
    this.returnPreview.set(null);
    try {
      const result = await firstValueFrom(this.paymentRefundApi.preview(detail.id, this.tenantContext.tenantId(), allocation.originalTransactionId));
      if (this.paylynxReturn() !== allocation) return;
      this.returnPreview.set(result);
      this.returnAmount.set(result.refundableAmount.toFixed(2));
      this.returnNeedsReview.set(false);
    } catch (error) {
      if (this.paylynxReturn() === allocation) this.returnError.set(this.refundErrorMessage(error));
    } finally {
      this.loadingReturn.set(false);
      if (this.paylynxReturn() && this.paylynxReturn() !== allocation) void this.loadPaylynxReturn();
    }
  }

  async confirmPaylynxReturn(): Promise<void> {
    const detail = this.invoice();
    const allocation = this.paylynxReturn();
    const preview = this.returnPreview();
    if (!detail || !allocation || !preview || !this.canSubmitReturn()) return;
    const amount = this.returnNetAmount();
    const creditInvoice = this.returnMode() === 'credit';
    this.refundingCustomer.set(true);
    this.returnError.set('');
    this.clearStatus();
    try {
      const { response, updated } = await this.submitProcessorRefund(detail,
        { ...allocation, alreadyReversed: preview.alreadyReversed }, amount, this.returnReason().trim(), {
          creditInvoice, expectedOperation: preview.operation,
          retainedFee: creditInvoice && preview.operation === 'refund' ? Number(this.returnFee()) : 0
        });
      if (updated) {
        this.invoice.set(updated);
        this.baselineSnapshot.set(this.snapshot(updated));
      }
      this.paylynxReturn.set(null);
      const action = response.operation === 'void' ? 'Voided' : 'Refunded';
      this.returnResult.set(`${action} ${this.formatUsd(amount)} through PayLynx.${creditInvoice ? ' Invoice credited.' : ''}`);
    } catch (error) {
      const failure = error as { status?: number; error?: { code?: string } };
      if (failure.error?.code === 'reversal_pending' || failure.status === 0) {
        this.returnNeedsReview.set(true);
        this.returnError.set('The reversal is awaiting confirmation. Check PayLynx before submitting again.');
      } else {
        if (failure.error?.code === 'reversal_changed') this.returnPreview.set(null);
        this.returnError.set(this.refundErrorMessage(error));
      }
    } finally {
      this.refundingCustomer.set(false);
    }
  }

  private async submitProcessorRefund(detail: InvoiceDetail, allocation: RefundAllocation, amount: number, reason?: string,
    returnDetails?: Pick<PaymentRefundPayload, 'creditInvoice' | 'retainedFee' | 'expectedOperation'>) {
    let accountNumber = allocation.accountNumber;
    if (allocation.provider === 'authorize-net') {
      accountNumber ||= this.promptLast4ForRefund(allocation.originalTransactionId, amount);
      if (!accountNumber) throw new Error('Last 4 card digits are required to process this refund.');
    }
    const response = await firstValueFrom(this.paymentRefundApi.refund({
      invoiceId: detail.id,
      tenantId: this.tenantContext.tenantId(),
      provider: allocation.provider,
      amount: amount.toFixed(2),
      invoiceNumber: detail.invoiceNumber,
      originalTransactionId: allocation.originalTransactionId,
      alreadyReversed: allocation.alreadyReversed,
      accountNumber,
      reason,
      ...returnDetails
    }));
    const settled = this.normalizeRefundResponse(response, allocation, amount);
    const updated = this.invoicesData.recordProcessorRefund(detail.id, {
      ...settled,
      reason,
      id: response.reversal?.id,
      createdAt: response.reversal?.createdAt,
      paidAmount: response.paidAmount,
      returnCreditAmount: response.returnCreditAmount,
      creditInvoice: returnDetails?.creditInvoice,
      retainedFee: returnDetails?.retainedFee,
      operation: response.operation
    });
    return { response, updated };
  }

  async refundCustomerOverpayment(): Promise<void> {
    this.closeInvoiceActionsMenu();
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice' || this.refundingCustomer()) return;

    const overpayment = this.overpaymentAmount();
    if (overpayment <= 0) {
      this.setStatus('No overpayment found on this invoice.', 'neutral');
      return;
    }

    const allocations = this.buildRefundAllocations(detail, overpayment);
    let refundableTotal = this.roundCurrency(allocations.reduce((sum, item) => sum + item.refundableAmount, 0));
    if (refundableTotal + 0.009 < overpayment) {
      const remaining = this.roundCurrency(Math.max(0, overpayment - refundableTotal));
      const manual = this.promptManualRefundAllocation(detail, remaining);
      if (manual) {
        allocations.push(manual);
        refundableTotal = this.roundCurrency(allocations.reduce((sum, item) => sum + item.refundableAmount, 0));
      }
    }

    if (!allocations.length || refundableTotal + 0.009 < overpayment) {
      this.setStatus('Overpayment exists, but no eligible processor transactions are available for automatic refund.', 'error');
      return;
    }

    const confirmed = window.confirm(
      `Refund ${this.formatUsd(overpayment)} to ${detail.customerName || 'customer'} for invoice ${detail.invoiceNumber}?`
    );
    if (!confirmed) return;

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
        const { updated } = await this.submitProcessorRefund(detail, allocation, amountToRefund, reason);
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

  async printPaidInvoice(): Promise<void> {
    this.closeInvoiceActionsMenu();
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice') return;
    const popup = window.open('about:blank', '_blank', 'width=1024,height=900');
    if (!popup) {
      this.setStatus('Popup blocked. Enable popups to print invoice.', 'error');
      return;
    }

    try {
      const checkout = this.withCurrentPaymentLink(detail);
      const amountDue = this.amountDue();
      const paymentLink = checkout.paymentLinkUrl || '';
      const publicLink = amountDue > 0 && paymentLink
        ? await this.publishInvoicePaymentSnapshotUrl(checkout, paymentLink, amountDue, true)
        : '';
      const html = amountDue === 0 && ['accepted', 'completed'].includes(detail.stage)
        ? this.buildPaidReceiptPrintHtml(detail, this.displayPaidDate(detail))
        : this.buildInvoicePrintHtml(detail, publicLink, amountDue);
      popup.document.open('text/html', 'replace');
      popup.document.write(html);
      popup.document.close();
    } catch {
      popup.close();
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
    if (kind === 'draft') return 'file';
    if (kind === 'sent') return 'mail-opened';
    if (kind === 'accepted') return 'check';
    if (kind === 'declined') return 'x';
    if (kind === 'paused') return 'player-pause';
    return 'alert-circle';
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

  toggleInvoiceActionsMenu(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.invoiceActionsMenuOpen.update(value => !value);
  }

  closeInvoiceActionsMenu(): void {
    this.invoiceActionsMenuOpen.set(false);
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    if (this.invoiceActionsMenuOpen()) this.invoiceActionsMenuOpen.set(false);
    if (this.activeLineItemSearchId()) this.activeLineItemSearchId.set('');
  }

  canCancelInvoice(): boolean {
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice') return false;
    if (detail.stage === 'accepted' || detail.stage === 'completed' || detail.stage === 'canceled') return false;
    const paid = this.roundCurrency(this.paidAmount());
    const due = this.roundCurrency(this.amountDue());
    // Per business rule: never cancel once any payment is captured, and balance must be zero.
    return paid <= 0 && due <= 0;
  }

  async cancelInvoice(): Promise<void> {
    this.closeInvoiceActionsMenu();
    const detail = this.invoice();
    if (!detail || detail.documentType !== 'invoice') return;
    if (!this.canCancelInvoice()) {
      this.setStatus('Invoice can be canceled only when unpaid and balance due is $0.00.', 'error');
      return;
    }

    const confirmed = window.confirm(`Cancel invoice ${detail.invoiceNumber}?`);
    if (!confirmed) return;

    const updated = this.invoicesData.setStage(
      detail.id,
      'canceled',
      'Invoice canceled by staff.',
      'system'
    );
    if (!updated) {
      this.setStatus('Could not cancel invoice.', 'error');
      return;
    }

    this.invoice.set(updated);
    this.baselineSnapshot.set(this.snapshot(updated));
    this.setStatus(`Invoice ${updated.invoiceNumber} canceled.`, 'success');
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

  private buildRefundAllocations(detail: InvoiceDetail, targetAmount: number, onlyProvider?: string): RefundAllocation[] {
    const wanted = this.roundCurrency(Math.max(0, Number(targetAmount || 0)));
    if (wanted <= 0) return [];

    const refundsByOriginal = new Map<string, number>();
    for (const refund of detail.refundTransactions || []) {
      const originalTransactionId = this.safeText((refund as InvoiceRefundTransaction).originalTransactionId);
      if (!originalTransactionId) continue;
      const refunded = this.roundCurrency(Math.max(0, Number((refund as InvoiceRefundTransaction).amount || 0)));
      const key = `${this.normalizeRefundProviderKey(refund.provider)}|${originalTransactionId}`;
      const next = this.roundCurrency((refundsByOriginal.get(key) || 0) + refunded);
      refundsByOriginal.set(key, next);
    }

    const payments = [...(detail.paymentTransactions || [])]
      .sort((a, b) => Date.parse(String(b.createdAt || '').trim()) - Date.parse(String(a.createdAt || '').trim()));

    let remainingTarget = wanted;
    const allocations: RefundAllocation[] = [];

    for (const payment of payments) {
      if (remainingTarget <= 0) break;
      const provider = this.normalizeRefundProviderKey(this.safeText((payment as InvoicePaymentTransaction).provider));
      if (!this.supportsAutomatedRefund(provider) || (onlyProvider && provider !== onlyProvider)) continue;

      const transactionId = this.safeText((payment as InvoicePaymentTransaction).transactionId);
      if (!transactionId) continue;

      const accountNumber = this.maskedAccountForRefund(this.safeText((payment as InvoicePaymentTransaction).accountNumber));

      const paid = this.roundCurrency(Math.max(0, Number((payment as InvoicePaymentTransaction).amount || 0)));
      const refunded = refundsByOriginal.get(`${provider}|${transactionId}`) || 0;
      const available = this.roundCurrency(Math.max(0, paid - refunded));
      if (available <= 0) continue;

      const portion = this.roundCurrency(Math.min(available, remainingTarget));
      allocations.push({
        provider,
        originalTransactionId: transactionId,
        accountNumber,
        alreadyReversed: refunded,
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
    return ['authorize-net', 'paylynx'].includes(this.normalizeRefundProviderKey(provider));
  }

  private normalizeRefundProviderKey(provider: string): string {
    const normalized = this.safeText(provider).toLowerCase().replace(/[\s_.]+/g, '-');
    if (!normalized) return '';
    if (normalized === 'authorizenet' || normalized === 'authorize-net' || normalized === 'authorize.net') {
      return 'authorize-net';
    }
    return normalized;
  }

  private promptManualRefundAllocation(detail: InvoiceDetail, remaining: number): RefundAllocation | null {
    const needed = this.roundCurrency(Math.max(0, Number(remaining || 0)));
    if (needed <= 0) return null;

    const provider = this.normalizeRefundProviderKey(this.safeText(detail.paymentProviderKey) || 'authorize-net');
    if (provider !== 'authorize-net') return null;

    const invoiceRef = this.safeText(detail.invoiceNumber || detail.id) || 'invoice';
    const transactionId = this.safeText(window.prompt(
      `Auto-refund data is incomplete for ${invoiceRef}. Enter original transaction ID to refund ${this.formatUsd(needed)}:`,
      ''
    ));
    if (!transactionId) return null;

    const digits = String(window.prompt('Enter last 4 card digits for this transaction:', '') || '').replace(/\D+/g, '');
    if (digits.length < 4) {
      this.setStatus('Refund canceled. Last 4 card digits are required for processor refund.', 'error');
      return null;
    }

    return {
      provider,
      originalTransactionId: transactionId,
      accountNumber: `XXXX${digits.slice(-4)}`,
      refundableAmount: needed
    };
  }

  private promptLast4ForRefund(originalTransactionId: string, amount: number): string {
    const digits = String(window.prompt(
      `Last 4 card digits are required to refund ${this.formatUsd(amount)} for transaction ${originalTransactionId}.`,
      ''
    ) || '').replace(/\D+/g, '');
    if (digits.length < 4) return '';
    return `XXXX${digits.slice(-4)}`;
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
      this.purchaseOrders.set([]);
      this.error.set('Invoice not found.');
      this.loading.set(false);
      return;
    }

    const expectedType = this.expectedDocumentTypeFromRoute();
    const found = this.findBestInvoiceForRoute(id, expectedType);
    if (!found) {
      if (!this.invoice() || this.invoice()!.id !== id) {
        this.invoice.set(null);
        this.purchaseOrders.set([]);
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
      || (this.snapshot(current) === this.baselineSnapshot() && this.baselineSnapshot() !== foundSnapshot);
    if (canHydrate) {
      this.invoice.set(found);
      this.baselineSnapshot.set(foundSnapshot);
      this.lineItemsPage.set(1);
      this.loadLinkedPurchaseOrders();
    }
    this.error.set('');
    this.loading.set(false);
    this.scheduleAutoOpenSendModal();
    this.scheduleAutoSendNow();
  }

  private loadLinkedPurchaseOrders(): void {
    this.purchaseOrdersApi.list().subscribe({
      next: res => this.purchaseOrders.set(Array.isArray(res?.items) ? res.items : []),
      error: () => this.purchaseOrders.set([])
    });
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

  private async markStaleWorkflowNotificationsRead(detail: InvoiceDetail): Promise<void> {
    const ids = await this.findUnreadWorkflowNotificationIds(detail);
    if (!ids.length) return;
    try {
      await firstValueFrom(this.notificationsApi.markReadBatch(ids));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('pathflow:notifications-refresh'));
      }
    } catch {
      // Notification cleanup is best-effort and should not block the workflow action.
    }
  }

  private async findUnreadWorkflowNotificationIds(detail: InvoiceDetail): Promise<string[]> {
    try {
      const response = await firstValueFrom(this.notificationsApi.listAll(100, 0));
      const items = Array.isArray(response.items) ? response.items : [];
      const ids = items
        .filter(item => !item.read && this.notificationBelongsToDocument(item, detail))
        .map(item => String(item.id || '').trim())
        .filter(Boolean);
      return Array.from(new Set(ids));
    } catch {
      return [];
    }
  }

  private notificationBelongsToDocument(notification: AppNotification, detail: InvoiceDetail): boolean {
    const documentId = String(detail.id || '').trim().toLowerCase();
    const documentNumber = String(detail.invoiceNumber || '').trim().toLowerCase();
    const customerName = String(detail.customerName || '').trim().toLowerCase();
    const route = String(notification.route || '').trim().toLowerCase();
    const entityId = String(notification.entityId || '').trim().toLowerCase();
    const metadata = notification.metadata || {};
    const metadataIds = [
      metadata['invoiceId'],
      metadata['quoteId'],
      metadata['documentId']
    ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
    const metadataNumbers = [
      metadata['invoiceNumber'],
      metadata['quoteNumber'],
      metadata['documentNumber']
    ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean);
    const metadataCustomer = String(metadata['customerName'] || '').trim().toLowerCase();

    if (documentId && (entityId === documentId || metadataIds.includes(documentId))) return true;
    if (documentId && route.includes(encodeURIComponent(documentId).toLowerCase())) return true;
    if (documentNumber && metadataNumbers.includes(documentNumber)) return true;

    const title = String(notification.title || '').trim().toLowerCase();
    const message = String(notification.message || '').trim().toLowerCase();
    const text = `${title} ${message}`;
    if (documentNumber && text.includes(documentNumber)) {
      if (!customerName || !metadataCustomer || metadataCustomer === customerName || text.includes(customerName)) return true;
    }

    return false;
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

  private invoiceBecamePaid(previousStage: InvoiceStage, saved: InvoiceDetail): boolean {
    if (!saved || saved.documentType !== 'invoice') return false;
    if (previousStage === 'accepted' || previousStage === 'completed') return false;
    return this.invoiceIsPaid(saved);
  }

  private invoiceIsPaid(invoice: InvoiceDetail): boolean {
    if (invoice.documentType !== 'invoice') return false;
    const total = this.roundCurrency(Math.max(0, Number(invoice.total || 0)));
    const paid = this.roundCurrency(Math.max(0, Number(invoice.paidAmount || 0)));
    if (invoice.stage !== 'accepted' && invoice.stage !== 'completed') return false;
    return total > 0 ? paid >= total : paid > 0;
  }

  private async syncPaidInvoicePartsIfNeeded(previousStage: InvoiceStage, saved: InvoiceDetail): Promise<boolean> {
    if (!this.invoiceBecamePaid(previousStage, saved)) return true;
    try {
      await firstValueFrom(this.invoiceResponseApi.recordManualPayment({
        invoiceId: saved.id,
        action: 'pay',
        tenantId: String(this.tenantContext.tenantId() || '').trim().toLowerCase() || 'primary-location',
        invoiceNumber: saved.invoiceNumber,
        jobNumber: saved.jobNumber,
        customerId: saved.customerId,
        customerName: saved.customerName,
        vehicle: saved.vehicle,
        businessName: saved.businessName,
        paymentAmount: this.roundCurrency(Number(saved.paidAmount || saved.total || 0) -
          Number(this.invoicesData.getInvoiceById(saved.id)?.paidAmount || 0)),
        lineItems: saved.lineItems.map(line => ({ ...line }))
      }));
      return true;
    } catch {
      return false;
    }
  }

  private async autoCompleteWorkItemOnInvoiceCompleted(
    previousStage: InvoiceStage,
    saved: InvoiceDetail
  ): Promise<'completed' | 'failed' | 'noop'> {
    const movedToCompleted = saved.stage === 'completed';
    const alreadyCompleted = previousStage === 'completed';
    if (alreadyCompleted || !movedToCompleted) return 'noop';

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

  private patchLineItem(lineId: string, patch: Partial<InvoiceLineItem>): void {
    const id = String(lineId || '').trim();
    if (!id) return;
    this.invoice.update(current => {
      if (!current) return current;
      const nextLines = current.lineItems.map(line => {
        if (line.id !== id) return line;
        return this.recalculateLine({ ...line, ...patch });
      });
      return {
        ...current,
        lineItems: nextLines,
        updatedAt: new Date().toISOString()
      };
    });
    this.clearStatus();
  }

  private safeNumber(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed;
  }

  private async ensureLineItemSourcesLoaded(): Promise<void> {
    if (this.lineItemSourcesLoaded || this.loadingLineItemSources) return;
    this.loadingLineItemSources = true;
    try {
      const [inventoryRes, laborRatesRes] = await Promise.all([
        firstValueFrom(this.inventoryApi.listItems()),
        firstValueFrom(this.settingsApi.getValue<LaborRateOption[]>(BUSINESS_LABOR_RATES_SETTING_KEY))
      ]);
      const inventoryItems = Array.isArray(inventoryRes?.items) ? inventoryRes.items : [];
      this.inventoryItems.set(inventoryItems.map(item => this.normalizeInventoryItem(item)));
      this.laborRates.set(
        (Array.isArray(laborRatesRes) ? laborRatesRes : [])
          .map((row, index) => ({
            id: String((row as Partial<LaborRateOption>)?.id || '').trim() || `labor-${index}`,
            name: String((row as Partial<LaborRateOption>)?.name || '').trim(),
            price: this.roundCurrency(Math.max(0, Number((row as Partial<LaborRateOption>)?.price || 0))),
            taxable: !!(row as Partial<LaborRateOption>)?.taxable
          }))
          .filter(item => !!item.name)
      );
      this.lineItemSourcesLoaded = true;
    } catch {
      // Keep manual editing available even if lookup sources fail.
    } finally {
      this.loadingLineItemSources = false;
    }
  }

  private normalizeInventoryItem(item: InventoryItem): InventoryItem {
    const raw = item as InventoryItem & Record<string, unknown>;
    const name = this.text(raw.name, this.text(raw['description'], 'Part'));
    const sku = this.text(raw.sku, this.text(raw['partLaborCode'], ''));
    const vendor = this.text(raw.vendor, this.text(raw['mainSupplier'], ''));
    const category = this.text(raw.category, '');
    const unitCost = this.safeNumber(raw.unitCost, this.safeNumber(raw.cost, 0));
    const price = this.safeNumber(raw.price, unitCost);
    return {
      ...item,
      name,
      sku,
      vendor,
      category,
      unitCost,
      cost: this.safeNumber(raw.cost, unitCost),
      price
    };
  }

  inventoryName(item: InventoryItem): string {
    const raw = item as InventoryItem & Record<string, unknown>;
    return this.text(raw.name, this.text(raw['description'], 'Part'));
  }

  inventorySku(item: InventoryItem): string {
    const raw = item as InventoryItem & Record<string, unknown>;
    return this.text(raw.sku, this.text(raw['partLaborCode'], ''));
  }

  inventoryVendor(item: InventoryItem): string {
    const raw = item as InventoryItem & Record<string, unknown>;
    return this.text(raw.vendor, this.text(raw['mainSupplier'], ''));
  }

  inventoryCategory(item: InventoryItem): string {
    const raw = item as InventoryItem & Record<string, unknown>;
    return this.text(raw.category, '');
  }

  private text(primary: unknown, fallback = ''): string {
    const first = String(primary ?? '').trim();
    if (first) return first;
    return String(fallback ?? '').trim();
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
    if (normalized === 'out-of-stock' || normalized === 'out of stock' || normalized === 'outofstock') return 'out-of-stock';
    if (normalized === 'in-stock' || normalized === 'in stock' || normalized === 'instock') return 'in-stock';
    if (normalized === 'ordered' || normalized === 'on-order' || normalized === 'on order') return 'ordered';
    if (normalized === 'backordered' || normalized === 'back-order' || normalized === 'back order') return 'backordered';
    if (normalized === 'received') return 'received';
    return 'out-of-stock';
  }

  partStatusLabel(value: InvoicePartStatus | string | undefined): string {
    const normalized = this.normalizePartStatus(value);
    if (normalized === 'in-stock') return 'In-stock';
    if (normalized === 'ordered') return 'Ordered';
    if (normalized === 'backordered') return 'Backordered';
    if (normalized === 'received') return 'Received';
    return 'Out of stock';
  }

  private withCurrentPaymentLink(detail: InvoiceDetail): InvoiceDetail {
    const provider = this.paymentAvailability().provider?.key;
    if (!provider) return detail;
    if (provider !== 'paylynx' && provider === detail.paymentProviderKey && detail.paymentLinkUrl?.trim()) return detail;
    return {
      ...detail,
      paymentProviderKey: provider,
      paymentLinkUrl: this.paymentSettings.createHostedPaymentLink(detail.id, detail.invoiceNumber) || ''
    };
  }

  private async publishInvoicePaymentSnapshotUrl(detail: InvoiceDetail, paymentLink: string, amountDue: number, keepExistingToken = false): Promise<string> {
    const publicToken = this.publicToken();
    const tenantId = String(this.tenantContext.tenantId() || 'main').trim().toLowerCase() || 'main';
    const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amountDue);
    const paymentProvider = String(detail.paymentProviderKey || '').trim().toLowerCase();
    const published = await firstValueFrom(this.invoiceResponseApi.publishSnapshot({
      invoiceId: detail.id,
      publicToken,
      keepExistingToken,
      tenantId,
      invoiceNumber: detail.invoiceNumber,
      customerName: detail.customerName || 'Customer',
      customerEmail: String(detail.customerEmail || '').trim(),
      vehicle: detail.vehicle || 'Vehicle details pending',
      businessName: detail.businessName || 'Our team',
      amount,
      dueDate: detail.dueDate || '',
      paymentUrl: paymentLink,
      paymentProvider,
      invoiceData: this.invoicePaymentPayload(detail)
    }));
    if (!published?.ok || published.invoiceId !== detail.id || !published.publicToken) {
      throw new Error('Could not publish the invoice payment link.');
    }

    const query = new URLSearchParams();
    query.set('invoiceId', detail.id);
    query.set('tenantId', tenantId);
    query.set('publicToken', published.publicToken);
    return this.publicRouteUrl('/invoice-payment', query);
  }

  private invoicePaymentPayload(detail: InvoiceDetail): unknown {
    return {
      jobNumber: String(detail.jobNumber || '').trim(),
      customerId: String(detail.customerId || '').trim(),
      subtotal: this.roundCurrency(Number(detail.subtotal || 0)),
      taxTotal: this.roundCurrency(Number(detail.taxTotal || 0)),
      total: this.roundCurrency(Number(detail.total || 0) + Number(detail.returnCreditAmount || 0)),
      lineItems: (detail.lineItems || []).map(line => ({
        id: String(line.id || '').trim(),
        type: String(line.type || '').trim().toLowerCase(),
        jobPartId: String(line.jobPartId || '').trim(),
        relatedInventoryItemId: String(line.relatedInventoryItemId || '').trim(),
        partStatus: String(line.partStatus || '').trim(),
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
  }

  private async publishQuoteSnapshot(detail: InvoiceDetail, publicToken: string): Promise<void> {
    const quotePayload = this.buildPublicQuotePayloadObject(detail);
    const published = await firstValueFrom(this.quoteResponseApi.publishSnapshot({
      quoteId: String(detail.id || '').trim(),
      publicToken,
      tenantId: String(this.tenantContext.tenantId() || 'main').trim().toLowerCase() || 'main',
      quoteNumber: String(detail.invoiceNumber || '').trim(),
      customerName: String(detail.customerName || 'Customer').trim(),
      vehicle: String(detail.vehicle || 'Vehicle details pending').trim(),
      businessName: String(detail.businessName || 'Our team').trim(),
      quoteData: quotePayload
    }));
    if (!published?.ok || published.publicToken !== publicToken || published.quoteId !== String(detail.id || '').trim()) {
      throw new Error('Quote link publication was not confirmed. Nothing was sent.');
    }


  }

  private publicToken(): string {
    const cryptoApi = typeof crypto !== 'undefined' ? crypto : null;
    if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
      return cryptoApi.randomUUID().replace(/-/g, '');
    }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  }

  private buildQuoteEmailHtml(
    detail: InvoiceDetail,
    business: string,
    viewUrl: string
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
          <a href="${this.escapeHtml(viewUrl)}" style="display:inline-block;margin-right:8px;background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;font-weight:700;">Review quote in your portal</a>
        </p>
        ${description ? `<p style="margin:8px 0 0;color:#334155;"><strong>Description:</strong> ${this.escapeHtml(description)}</p>` : ''}
        ${customerNote ? `<p style="margin:8px 0 0;color:#334155;"><strong>Customer Note:</strong> ${this.escapeHtml(customerNote)}</p>` : ''}
        <p style="margin:14px 0 0;color:#334155;">If you have questions, reply to this email and ${this.escapeHtml(business)} will help.</p>
      </div>
    `;
  }

  private buildPublicQuotePayloadObject(detail: InvoiceDetail): Record<string, unknown> {
    return {
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
  }

  private buildInvoiceEmailHtml(detail: InvoiceDetail, publicLink: string, business: string, amountDue: number): string {
    const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    const subtotal = Number(detail.subtotal || 0);
    const taxTotal = Number(detail.taxTotal || 0);
    const total = Number(detail.total || 0);
    const returnCredit = Number(detail.returnCreditAmount || 0);
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
          ${returnCredit > 0 ? `<tr>
            <td style="padding:8px 10px;color:#111827;">Return Credit:</td>
            <td style="padding:8px 10px;color:#111827;text-align:right;font-weight:700;">${this.escapeHtml(money.format(-returnCredit))}</td>
          </tr>` : ''}
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

        ${publicLink ? `<div style="margin:14px 0 4px;">
          <a href="${this.escapeHtml(publicLink)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:700;">Pay Invoice Now</a>
        </div>` : ''}
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

  private buildInvoicePrintHtml(detail: InvoiceDetail, publicLink: string, amountDue: number): string {
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
    const reversedAt = Math.max(0, ...(detail.refundTransactions || []).map(item => Date.parse(item.createdAt) || 0));
    return sentAt >= Math.max(updatedAt, reversedAt);
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
    if (/^https?:\/\//i.test(raw)) return this.isPublicHttpsUrl(raw) ? raw : '';
    const base = String(environment.publicAppUrl || '').trim().replace(/\/+$/, '');
    if (!base || !this.isPublicHttpsUrl(base)) return '';
    if (raw.startsWith('/')) return `${base}${raw}`;
    return `${base}/${raw}`;
  }

  private isLoopbackUrl(value: string): boolean {
    try {
      const url = new URL(String(value || '').trim(), 'http://localhost');
      const host = url.hostname.toLowerCase();
      return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
    } catch {
      return false;
    }
  }

  private isPublicHttpsUrl(value: string): boolean {
    try {
      const url = new URL(String(value || '').trim());
      return url.protocol === 'https:' && !this.isLoopbackUrl(url.href);
    } catch {
      return false;
    }
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

  private extractSendFailureReason(error: unknown): string {
    const candidate = error as {
      error?: { error?: string; message?: string; title?: string; detail?: string; errors?: unknown };
      message?: string;
      statusText?: string;
      status?: number;
      url?: string;
    };
    const nestedErrors = candidate?.error?.errors
      ? (Array.isArray(candidate.error.errors)
        ? candidate.error.errors.join(', ')
        : JSON.stringify(candidate.error.errors))
      : '';
    const genericServerError = /^server error$/i.test(String(candidate?.error?.error || '').trim());
    const raw =
      (genericServerError ? '' : candidate?.error?.error) ||
      candidate?.error?.detail ||
      candidate?.error?.message ||
      candidate?.error?.title ||
      nestedErrors ||
      candidate?.message ||
      candidate?.statusText ||
      '';
    const normalized = String(raw).trim();
    if (!normalized) {
      const status = Number(candidate?.status || 0);
      const url = String(candidate?.url || '').trim();
      if (status && url) return `request failed with HTTP ${status} at ${url}`;
      if (status) return `request failed with HTTP ${status}`;
      return '';
    }
    if (/too\s*many\s*requests|\b429\b|rate limit|throttl/i.test(normalized)) {
      return 'email service is rate limiting right now; retry in a moment';
    }
    if (/verify|verified|verification/i.test(normalized)) return 'number not verified';
    if (/config|configured|from number|sender/i.test(normalized)) return 'sender not configured';
    if (/forbidden|unauthorized|401|403/i.test(normalized)) return 'not authorized';
    return normalized;
  }

  private composeDeliveryFailureMessage(
    label: 'Invoice' | 'Quote',
    attemptedEmail: boolean,
    attemptedSms: boolean,
    emailReason: string,
    smsReason: string
  ): string {
    const reasons: string[] = [];
    if (attemptedEmail) reasons.push(`Email${emailReason ? `: ${emailReason}` : ' failed'}`);
    if (attemptedSms) reasons.push(`SMS${smsReason ? `: ${smsReason}` : ' failed'}`);
    return `${label} send failed.${reasons.length ? ` ${reasons.join(' · ')}.` : ''}`;
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
