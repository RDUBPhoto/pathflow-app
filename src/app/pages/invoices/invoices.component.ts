import { CommonModule, CurrencyPipe } from '@angular/common';
import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';
import { ToastController } from '@ionic/angular';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../auth/auth.service';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import {
  INVOICE_LANES,
  InvoiceDetail,
  InvoiceBoardStage,
  InvoiceCard,
  InvoiceDocumentType,
  InvoiceLane,
  InvoiceStage,
  InvoicesDataService
} from '../../services/invoices-data.service';
import { QuoteResponseApiService } from '../../services/quote-response-api.service';
import { InvoiceResponseApiService } from '../../services/invoice-response-api.service';
import { EmailApiService } from '../../services/email-api.service';
import { TenantContextService } from '../../services/tenant-context.service';
import { ScheduleApi } from '../../services/schedule-api.service';
import { NotificationsApiService } from '../../services/notifications-api.service';

type InvoiceKpi = {
  id: string;
  label: string;
  value: number;
  kind: 'count' | 'currency';
  tone: 'open' | 'accepted' | 'declined' | 'expired' | 'neutral';
};
type InvoicesTab = 'quotes' | 'invoices';
const INVOICES_TAB_STORAGE_KEY = 'pathflow.quotesInvoices.activeTab';
const LOCAL_PENDING_QUOTE_RESPONSES_KEY = 'pathflow.quoteResponses.pending.v1';
const LOCAL_PENDING_INVOICE_RESPONSES_KEY = 'pathflow.invoiceResponses.pending.v1';
type PendingQuoteResponse = {
  quoteId: string;
  stage: 'accepted' | 'declined';
  tenantId: string;
  updatedAt: string;
};
type PendingInvoiceResponse = {
  invoiceId: string;
  stage: 'accepted';
  tenantId: string;
  updatedAt: string;
};

@Component({
  selector: 'app-invoices',
  standalone: true,
  imports: [
    CommonModule,
    CurrencyPipe,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    IonSegment,
    IonSegmentButton,
    RouterLink,
    PageBackButtonComponent,
    CompanySwitcherComponent,
    UserMenuComponent
  ],
  templateUrl: './invoices.component.html',
  styleUrls: ['./invoices.component.scss']
})
export default class InvoicesComponent implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly quoteResponseApi = inject(QuoteResponseApiService);
  private readonly invoiceResponseApi = inject(InvoiceResponseApiService);
  private readonly emailApi = inject(EmailApiService);
  private readonly auth = inject(AuthService);
  private readonly tenantContext = inject(TenantContextService);
  private readonly scheduleApi = inject(ScheduleApi);
  private readonly notificationsApi = inject(NotificationsApiService);
  private readonly toastController = inject(ToastController);
  private readonly laneDisplayOrder: InvoiceBoardStage[] = ['draft', 'sent', 'accepted', 'declined', 'completed'];
  private readonly quoteLanes: InvoiceLane[] = [...INVOICE_LANES].sort(
    (a, b) => this.laneDisplayOrder.indexOf(a.id) - this.laneDisplayOrder.indexOf(b.id)
  );
  private readonly invoiceLanes: InvoiceLane[] = [
    { id: 'draft', title: 'Drafts', color: '#ef4444' },
    { id: 'sent', title: 'Sent', color: '#14b8a6' },
    { id: 'accepted', title: 'Paid', color: '#22c55e' },
    { id: 'completed', title: 'Completed', color: '#60a5fa' }
  ];
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  readonly activeTab = signal<InvoicesTab>('quotes');
  readonly lanes = computed(() => this.activeTab() === 'quotes' ? this.quoteLanes : this.invoiceLanes);
  readonly searchQuery = signal('');
  readonly tabbedInvoices = computed(() => this.invoicesData.invoicesByType(this.documentTypeForTab(this.activeTab())));
  readonly scheduledCustomerIds = signal<Set<string>>(new Set());
  readonly filteredInvoices = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    const source = this.tabbedInvoices();
    if (!query) return source;

    return source.filter(invoice => {
      const amountText = invoice.total.toFixed(2);
      const haystack = [
        invoice.customerName,
        invoice.invoiceNumber,
        invoice.vehicle,
        invoice.template,
        invoice.invoicedAt,
        amountText,
        invoice.documentType
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  });
  readonly openStages: InvoiceStage[] = ['draft', 'sent'];
  readonly kpis = computed<InvoiceKpi[]>(() => {
    const source = this.filteredInvoices();
    const openBalance = this.sumByStage(this.openStages, source);
    const acceptedTotal = this.sumByStage(this.activeTab() === 'quotes' ? ['accepted'] : ['accepted', 'completed'], source);
    const expiredCount = source.filter(item => item.isExpired).length;

    return [
      { id: 'open-balance', label: 'Open Balance', value: openBalance, kind: 'currency', tone: 'open' },
      {
        id: 'accepted-total',
        label: this.activeTab() === 'quotes' ? 'Accepted Total' : 'Paid Total',
        value: acceptedTotal,
        kind: 'currency',
        tone: 'accepted'
      },
      { id: 'expired-count', label: 'Expired (30+ days)', value: expiredCount, kind: 'count', tone: 'expired' }
    ];
  });

  readonly laneCards = computed(() => {
    const grouped: Record<InvoiceBoardStage, InvoiceCard[]> = {
      draft: [],
      sent: [],
      accepted: [],
      declined: [],
      completed: []
    };
    const activeTab = this.activeTab();
    const detailsById = new Map<string, InvoiceDetail>();
    for (const detail of this.invoicesData.invoiceDetails()) {
      detailsById.set(String(detail.id || '').trim(), detail);
    }
    for (const invoice of this.filteredInvoices()) {
      if (invoice.isExpired) continue;
      if (invoice.stage === 'expired') continue;
      if (invoice.stage === 'canceled') continue;
      if (activeTab === 'invoices' && invoice.stage === 'declined') continue;
      if (activeTab === 'invoices') {
        if (invoice.stage === 'completed') {
          const detail = detailsById.get(String(invoice.id || '').trim()) || null;
          if (this.completedInvoiceExpired(detail)) continue;
          grouped.completed.push(invoice);
          continue;
        }
      }
      grouped[invoice.stage].push(invoice);
    }
    return grouped;
  });
  readonly deleteDialogOpen = signal(false);
  readonly deleteCandidate = signal<InvoiceCard | null>(null);
  readonly deleteError = signal('');
  readonly cancelDialogOpen = signal(false);
  readonly cancelCandidate = signal<InvoiceCard | null>(null);
  readonly cancelError = signal('');
  readonly openMenuId = signal<string | null>(null);

  constructor(private readonly router: Router) {
    this.route.queryParamMap.subscribe(params => {
      const tab = String(params.get('tab') || '').trim().toLowerCase();
      if (tab === 'invoices') {
        this.activeTab.set('invoices');
        this.persistActiveTab('invoices');
      } else if (tab === 'quotes') {
        this.activeTab.set('quotes');
        this.persistActiveTab('quotes');
      } else {
        const persisted = this.readPersistedTab();
        this.activeTab.set(persisted);
      }
    });

    void this.syncResponses();
    void this.refreshScheduledCustomers();
    this.syncTimer = setInterval(() => {
      void this.syncResponses();
      void this.refreshScheduledCustomers();
    }, 15000);
  }

  ngOnDestroy(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  openTemplatePicker(): void {
    this.router.navigate(['/invoices/new'], {
      queryParams: { type: this.documentTypeForTab(this.activeTab()) }
    });
  }

  trackLane(_index: number, lane: InvoiceLane): string {
    return lane.id;
  }

  laneCardsFor(lane: InvoiceLane): InvoiceCard[] {
    return this.laneCards()[lane.id];
  }

  trackInvoice(_index: number, invoice: InvoiceCard): string {
    return invoice.id;
  }

  trackKpi(_index: number, kpi: InvoiceKpi): string {
    return kpi.id;
  }

  documentRoute(invoice: InvoiceCard): string[] {
    if (invoice.documentType === 'quote') {
      return ['/quotes', invoice.id || invoice.invoiceNumber];
    }
    return ['/invoices', invoice.id];
  }

  openDocument(invoice: InvoiceCard, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.closeOpenMenu();
    void this.router.navigate(this.documentRoute(invoice));
  }

  setSearchQuery(value: string): void {
    this.searchQuery.set(value || '');
  }

  clearSearch(): void {
    this.searchQuery.set('');
  }

  setTab(tab: InvoicesTab): void {
    if (this.activeTab() === tab) return;
    this.activeTab.set(tab);
    this.persistActiveTab(tab);
    this.openMenuId.set(null);
    this.searchQuery.set('');
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab },
      queryParamsHandling: 'merge',
      replaceUrl: true
    });
  }

  onTabChanged(value: string | null | undefined): void {
    const next = String(value || '').trim().toLowerCase();
    this.setTab(next === 'invoices' ? 'invoices' : 'quotes');
  }

  requestDeleteDraft(invoice: InvoiceCard, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (invoice.stage !== 'draft') return;
    this.openMenuId.set(null);
    this.deleteError.set('');
    this.deleteCandidate.set(invoice);
    this.deleteDialogOpen.set(true);
  }

  cancelDeleteDraft(): void {
    this.deleteDialogOpen.set(false);
    this.deleteCandidate.set(null);
    this.deleteError.set('');
  }

  async confirmDeleteDraft(): Promise<void> {
    const candidate = this.deleteCandidate();
    if (!candidate) return;
    const removed = this.invoicesData.deleteDraftDocument(candidate.id);
    if (!removed) {
      this.deleteError.set(`Could not delete this draft ${candidate.documentType}. Please refresh and try again.`);
      await this.showDeleteToast(`Could not delete this draft ${candidate.documentType}.`, 'danger');
      return;
    }
    this.cancelDeleteDraft();
    await this.showDeleteToast('Draft removed.', 'success');
  }

  deleteDialogDocumentLabel(): string {
    const doc = this.deleteCandidate()?.documentType;
    return doc === 'invoice' ? 'Invoice' : 'Quote';
  }

  requestCancelQuote(invoice: InvoiceCard, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (invoice.documentType !== 'quote' || invoice.stage !== 'sent') return;
    this.openMenuId.set(null);
    this.cancelError.set('');
    this.cancelCandidate.set(invoice);
    this.cancelDialogOpen.set(true);
  }

  cancelQuoteDialog(): void {
    this.cancelDialogOpen.set(false);
    this.cancelCandidate.set(null);
    this.cancelError.set('');
  }

  async confirmCancelQuote(): Promise<void> {
    const candidate = this.cancelCandidate();
    if (!candidate) return;
    const detail = this.invoicesData.getInvoiceById(candidate.id);
    if (!detail || detail.documentType !== 'quote' || detail.stage !== 'sent') {
      this.cancelError.set('Could not cancel this quote. Please refresh and try again.');
      await this.showDeleteToast('Could not cancel this quote.', 'danger');
      return;
    }

    this.invoicesData.setStage(
      candidate.id,
      'canceled',
      'Quote canceled by staff before customer approval.'
    );

    let emailSent = false;
    const to = String(detail.customerEmail || candidate.customerEmail || '').trim();
    if (to) {
      const business = String(detail.businessName || '').trim() || 'Our team';
      const subject = `Quote ${detail.invoiceNumber} canceled`;
      const message = `Your quote ${detail.invoiceNumber} has been canceled. If you have questions, reply to this email and ${business} will help.`;
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111827;">
        <p>Your quote <strong>${detail.invoiceNumber}</strong> has been canceled.</p>
        <p>If you have questions, reply to this email and <strong>${business}</strong> will help.</p>
      </div>`;
      try {
        await firstValueFrom(this.emailApi.sendToCustomer({
          customerId: String(detail.customerId || '').trim(),
          customerName: String(detail.customerName || '').trim(),
          to,
          subject,
          message,
          html
        }));
        emailSent = true;
      } catch {
        emailSent = false;
      }
    }

    this.cancelQuoteDialog();
    if (emailSent) {
      await this.showDeleteToast('Quote canceled and customer email sent.', 'success');
    } else if (to) {
      await this.showDeleteToast('Quote canceled, but customer email failed to send.', 'danger');
    } else {
      await this.showDeleteToast('Quote canceled. No customer email on file.', 'warning');
    }
  }

  toggleCardMenu(invoice: InvoiceCard, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const current = this.openMenuId();
    this.openMenuId.set(current === invoice.id ? null : invoice.id);
  }

  closeOpenMenu(): void {
    if (this.openMenuId()) this.openMenuId.set(null);
  }

  private sumByStage(stages: InvoiceStage[], source: InvoiceCard[]): number {
    const stageSet = new Set(stages);
    return source.reduce((sum, invoice) => (invoice.isExpired ? sum : (stageSet.has(invoice.stage) ? sum + invoice.total : sum)), 0);
  }

  private completedInvoiceExpired(detail: InvoiceDetail | null): boolean {
    const completedAtMs = this.completedAtMillis(detail);
    if (!completedAtMs) return false;
    const todayKey = this.localDayKey(new Date());
    const completedDay = this.localDayKey(new Date(completedAtMs));
    if (!todayKey || !completedDay) return false;
    return completedDay < todayKey;
  }

  private completedAtMillis(detail: InvoiceDetail | null): number {
    if (!detail || detail.documentType !== 'invoice' || detail.stage !== 'completed') return 0;
    const explicit = this.latestStageTransitionAt(detail, 'completed');
    if (explicit) return explicit;
    return this.asMillis(detail.updatedAt || detail.paymentDate || detail.createdAt || '');
  }

  private latestStageTransitionAt(detail: InvoiceDetail, targetStage: 'completed'): number {
    const needle = `updated to ${targetStage}`;
    let latest = 0;
    for (const entry of detail.timeline || []) {
      const createdAt = this.asMillis(String(entry?.createdAt || '').trim());
      if (!createdAt) continue;
      const message = String(entry?.message || '').trim().toLowerCase();
      if (!message.includes(needle)) continue;
      if (createdAt > latest) latest = createdAt;
    }
    return latest;
  }

  private asMillis(value: string): number {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private localDayKey(value: Date): string {
    if (!Number.isFinite(value.getTime())) return '';
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private documentTypeForTab(tab: InvoicesTab): InvoiceDocumentType {
    return tab === 'quotes' ? 'quote' : 'invoice';
  }

  private persistActiveTab(tab: InvoicesTab): void {
    try {
      localStorage.setItem(INVOICES_TAB_STORAGE_KEY, tab);
    } catch {
      // Ignore storage failures.
    }
  }

  private readPersistedTab(): InvoicesTab {
    try {
      const value = String(localStorage.getItem(INVOICES_TAB_STORAGE_KEY) || '').trim().toLowerCase();
      return value === 'invoices' ? 'invoices' : 'quotes';
    } catch {
      return 'quotes';
    }
  }

  private async showDeleteToast(message: string, color: 'success' | 'danger' | 'warning'): Promise<void> {
    const toast = await this.toastController.create({
      message,
      color,
      duration: 1800,
      position: 'top'
    });
    await toast.present();
  }

  private async syncResponses(): Promise<void> {
    await Promise.all([
      this.syncQuoteResponses(),
      this.syncInvoiceResponses()
    ]);
  }

  private async refreshScheduledCustomers(): Promise<void> {
    try {
      const rows = await firstValueFrom(this.scheduleApi.list());
      const now = Date.now();
      const next = new Set<string>();
      for (const row of Array.isArray(rows) ? rows : []) {
        const customerId = String(row?.customerId || '').trim();
        if (!customerId) continue;
        const endMillis = Date.parse(String(row?.end || ''));
        if (Number.isFinite(endMillis) && endMillis < now) continue;
        next.add(customerId);
      }
      this.scheduledCustomerIds.set(next);
    } catch {
      // Keep current set on transient failures.
    }
  }

  private async syncQuoteResponses(): Promise<void> {
    const collected: Array<{ quoteId: string; stage: 'accepted' | 'declined'; updatedAt: string }> = [];
    try {
      const response = await firstValueFrom(this.quoteResponseApi.listRecent(250));
      const items = Array.isArray(response?.items) ? response.items : [];
      for (const item of items) {
        const quoteId = String(item?.quoteId || '').trim();
        const stage = String(item?.stage || '').trim().toLowerCase();
        const updatedAt = String(item?.updatedAt || '').trim() || new Date().toISOString();
        if (!quoteId) continue;
        if (stage !== 'accepted' && stage !== 'declined') continue;
        collected.push({ quoteId, stage, updatedAt });
      }
    } catch {
      // Keep local fallback sync running even when API is unavailable.
    }

    const pendingLocal = this.readPendingQuoteResponses();
    if (pendingLocal.length) {
      const activeTenant = String(this.tenantContext.tenantId() || '').trim().toLowerCase() || 'main';
      for (const item of pendingLocal) {
        const tenantId = String(item?.tenantId || '').trim().toLowerCase();
        if (tenantId && tenantId !== activeTenant) continue;
        const quoteId = String(item?.quoteId || '').trim();
        const stage = String(item?.stage || '').trim().toLowerCase();
        const updatedAt = String(item?.updatedAt || '').trim() || new Date().toISOString();
        if (!quoteId) continue;
        if (stage !== 'accepted' && stage !== 'declined') continue;
        collected.push({ quoteId, stage, updatedAt });
      }
    }

    const deduped = new Map<string, { quoteId: string; stage: 'accepted' | 'declined'; updatedAt: string }>();
    for (const row of collected) {
      const key = String(row.quoteId || '').trim().toLowerCase();
      if (!key) continue;
      const previous = deduped.get(key);
      if (!previous || Date.parse(row.updatedAt) >= Date.parse(previous.updatedAt)) {
        deduped.set(key, row);
      }
    }

    const appliedIds: string[] = [];
    for (const item of deduped.values()) {
      const existing = this.invoicesData.getInvoiceById(item.quoteId);
      if (!existing || existing.documentType !== 'quote') continue;
      if (existing.stage === 'canceled' || existing.stage === 'expired') continue;
      if (existing.stage === item.stage) continue;
      this.invoicesData.setStage(
        item.quoteId,
        item.stage,
        `Customer ${item.stage === 'accepted' ? 'accepted' : 'declined'} quote from public link.`,
        'customer'
      );
      await this.createQuoteStatusNotification(existing.id, existing.invoiceNumber, existing.customerName, item.stage);
      appliedIds.push(item.quoteId);
    }

    if (appliedIds.length) {
      this.removePendingQuoteResponses(appliedIds);
    }
  }

  private async syncInvoiceResponses(): Promise<void> {
    const collected: Array<{ invoiceId: string; invoiceNumber: string; stage: 'accepted'; updatedAt: string }> = [];
    try {
      const response = await firstValueFrom(this.invoiceResponseApi.listRecent(250));
      const items = Array.isArray(response?.items) ? response.items : [];
      for (const item of items) {
        const invoiceId = String(item?.invoiceId || '').trim();
        const stage = String(item?.stage || '').trim().toLowerCase();
        const invoiceNumber = String(item?.invoiceNumber || '').trim();
        const updatedAt = String(item?.updatedAt || '').trim() || new Date().toISOString();
        if (!invoiceId) continue;
        if (stage !== 'accepted') continue;
        collected.push({ invoiceId, invoiceNumber, stage: 'accepted', updatedAt });
      }
    } catch {
      // Keep local fallback sync running even when API is unavailable.
    }

    const pendingLocal = this.readPendingInvoiceResponses();
    if (pendingLocal.length) {
      const activeTenant = String(this.tenantContext.tenantId() || '').trim().toLowerCase() || 'main';
      for (const item of pendingLocal) {
        const tenantId = String(item?.tenantId || '').trim().toLowerCase();
        if (tenantId && tenantId !== activeTenant) continue;
        const invoiceId = String(item?.invoiceId || '').trim();
        const stage = String(item?.stage || '').trim().toLowerCase();
        const updatedAt = String(item?.updatedAt || '').trim() || new Date().toISOString();
        if (!invoiceId) continue;
        if (stage !== 'accepted') continue;
        collected.push({ invoiceId, invoiceNumber: '', stage: 'accepted', updatedAt });
      }
    }

    const deduped = new Map<string, { invoiceId: string; invoiceNumber: string; stage: 'accepted'; updatedAt: string }>();
    for (const row of collected) {
      const key = String(row.invoiceId || '').trim().toLowerCase();
      if (!key) continue;
      const previous = deduped.get(key);
      if (!previous || Date.parse(row.updatedAt) >= Date.parse(previous.updatedAt)) {
        deduped.set(key, row);
      }
    }

    const appliedIds: string[] = [];
    for (const item of deduped.values()) {
      const existing = this.invoicesData.getInvoiceById(item.invoiceId)
        || (item.invoiceNumber ? this.invoicesData.getInvoiceById(item.invoiceNumber) : null);
      if (!existing || existing.documentType !== 'invoice') continue;
      const responseUpdatedMs = Date.parse(String(item.updatedAt || '').trim() || new Date().toISOString());
      const invoiceUpdatedMs = Date.parse(String(existing.updatedAt || existing.createdAt || '').trim());
      if (Number.isFinite(responseUpdatedMs) && Number.isFinite(invoiceUpdatedMs) && responseUpdatedMs < invoiceUpdatedMs) continue;
      if (existing.stage === 'accepted' && Number(existing.paidAmount || 0) >= Number(existing.total || 0)) continue;
      const paidBefore = Math.max(0, Number(existing.paidAmount || 0));
      const wasFinalInvoicePayment = paidBefore > 0 && paidBefore < Math.max(0, Number(existing.total || 0));
      this.invoicesData.setPaidAmount(
        existing.id,
        Number(existing.total || 0),
        'Customer paid invoice from public payment link.',
        'customer'
      );
      if (wasFinalInvoicePayment) {
        this.invoicesData.setStage(existing.id, 'completed', 'Final invoice paid by customer. Marked as Completed.', 'customer');
      }
      await this.createInvoicePaidNotification(existing.id, existing.invoiceNumber, existing.customerName, wasFinalInvoicePayment);
      appliedIds.push(item.invoiceId);
    }

    if (appliedIds.length) {
      this.removePendingInvoiceResponses(appliedIds);
    }
  }

  private readPendingQuoteResponses(): PendingQuoteResponse[] {
    try {
      const raw = localStorage.getItem(LOCAL_PENDING_QUOTE_RESPONSES_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private removePendingQuoteResponses(quoteIds: string[]): void {
    try {
      const removeSet = new Set(quoteIds.map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
      if (!removeSet.size) return;
      const current = this.readPendingQuoteResponses();
      const filtered = current.filter(item => !removeSet.has(String(item?.quoteId || '').trim().toLowerCase()));
      localStorage.setItem(LOCAL_PENDING_QUOTE_RESPONSES_KEY, JSON.stringify(filtered));
    } catch {
      // Ignore localStorage failures.
    }
  }

  private readPendingInvoiceResponses(): PendingInvoiceResponse[] {
    try {
      const raw = localStorage.getItem(LOCAL_PENDING_INVOICE_RESPONSES_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private removePendingInvoiceResponses(invoiceIds: string[]): void {
    try {
      const removeSet = new Set(invoiceIds.map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
      if (!removeSet.size) return;
      const current = this.readPendingInvoiceResponses();
      const filtered = current.filter(item => !removeSet.has(String(item?.invoiceId || '').trim().toLowerCase()));
      localStorage.setItem(LOCAL_PENDING_INVOICE_RESPONSES_KEY, JSON.stringify(filtered));
    } catch {
      // Ignore localStorage failures.
    }
  }

  private async createQuoteStatusNotification(
    quoteId: string,
    quoteNumber: string,
    customerName: string,
    stage: 'accepted' | 'declined'
  ): Promise<void> {
    const user = this.auth.user();
    if (!user) return;

    const targetUserId = String(user.id || '').trim();
    const targetEmail = String(user.email || '').trim();
    if (!targetUserId && !targetEmail) return;

    const number = String(quoteNumber || quoteId || '').trim() || 'Quote';
    const customer = String(customerName || '').trim() || 'Customer';
    const accepted = stage === 'accepted';

    try {
      await firstValueFrom(
        this.notificationsApi.createMention({
          targetUserId: targetUserId || undefined,
          targetEmail: targetEmail || undefined,
          targetDisplayName: String(user.displayName || '').trim() || undefined,
          title: `Quote ${number} ${accepted ? 'accepted' : 'declined'}`,
          message: `${customer} ${accepted ? 'accepted' : 'declined'} quote ${number}.`,
          route: `/quotes/${encodeURIComponent(quoteId || number)}`,
          entityType: 'quote',
          entityId: quoteId || number,
          metadata: {
            quoteId: quoteId || '',
            quoteNumber: number,
            customerName: customer,
            stage,
            source: 'response-sync'
          }
        })
      );
    } catch {
      // Notification failures must not block status sync.
    }
  }

  private async createInvoicePaidNotification(
    invoiceId: string,
    invoiceNumber: string,
    customerName: string,
    isFinalInvoice: boolean
  ): Promise<void> {
    const user = this.auth.user();
    if (!user) return;

    const targetUserId = String(user.id || '').trim();
    const targetEmail = String(user.email || '').trim();
    if (!targetUserId && !targetEmail) return;

    const number = String(invoiceNumber || invoiceId || '').trim() || 'Invoice';
    const customer = String(customerName || '').trim() || 'Customer';
    const titlePrefix = isFinalInvoice ? 'Final invoice' : 'Invoice';
    const messageBody = isFinalInvoice
      ? `${customer} paid final invoice ${number}.`
      : `${customer} paid invoice ${number}.`;

    try {
      await firstValueFrom(
        this.notificationsApi.createMention({
          targetUserId: targetUserId || undefined,
          targetEmail: targetEmail || undefined,
          targetDisplayName: String(user.displayName || '').trim() || undefined,
          title: `${titlePrefix} ${number} paid`,
          message: messageBody,
          route: `/invoices/${encodeURIComponent(invoiceId || number)}`,
          entityType: 'invoice',
          entityId: invoiceId || number,
          metadata: {
            invoiceId: invoiceId || '',
            invoiceNumber: number,
            customerName: customer,
            stage: 'accepted',
            paymentKind: isFinalInvoice ? 'final' : 'initial',
            source: 'response-sync'
          }
        })
      );
    } catch {
      // Notification failures must not block status sync.
    }
  }

}
