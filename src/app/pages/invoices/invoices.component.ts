import { UiTab, UiTabs } from '../../ui/controls';
import { ToastController } from '../../ui/overlays';
import { CommonModule, CurrencyPipe } from '@angular/common';
import { Component, OnDestroy, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { firstValueFrom, forkJoin } from 'rxjs';
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
import { shopTimeMillis } from '../../utils/shop-time';

type InvoiceKpi = {
  id: string;
  label: string;
  value: number;
  kind: 'count' | 'currency';
  tone: 'open' | 'accepted' | 'declined' | 'expired' | 'neutral';
  range: KpiRange;
  rangeLabel: string;
};
type InvoicesTab = 'quotes' | 'invoices';
type KpiRange = 'today' | 'wtd' | 'mtd' | 'ytd' | 'all';
const INVOICES_TAB_STORAGE_KEY = 'pathflow.quotesInvoices.activeTab';
const INVOICES_KPI_RANGE_STORAGE_KEY = 'pathflow.quotesInvoices.kpiRanges';
const LOCAL_PENDING_QUOTE_RESPONSES_KEY = 'pathflow.quoteResponses.pending.v1';
type PendingQuoteResponse = {
  quoteId: string;
  stage: 'accepted' | 'declined';
  tenantId: string;
  updatedAt: string;
};

@Component({
  selector: 'app-invoices',
  standalone: true,
  imports: [
    CommonModule,
    CurrencyPipe,
    UiTabs,
    UiTab,
    RouterLink,
    PageBackButtonComponent,
    CompanySwitcherComponent,
    UserMenuComponent
  ],
  templateUrl: './invoices.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./invoices.component.scss']
})
export default class InvoicesComponent implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly invoicesData = inject(InvoicesDataService);
  readonly documentSyncError = this.invoicesData.documentSyncError;
  private readonly quoteResponseApi = inject(QuoteResponseApiService);
  private readonly invoiceResponseApi = inject(InvoiceResponseApiService);
  private readonly emailApi = inject(EmailApiService);
  private readonly auth = inject(AuthService);
  private readonly tenantContext = inject(TenantContextService);
  private readonly scheduleApi = inject(ScheduleApi);
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
  readonly kpiRanges = signal<Record<string, KpiRange>>({});
  readonly kpiRangeOptions: Array<{ id: KpiRange; label: string }> = [
    { id: 'today', label: 'Today' },
    { id: 'wtd', label: 'WTD' },
    { id: 'mtd', label: 'MTD' },
    { id: 'ytd', label: 'YTD' },
    { id: 'all', label: 'All' }
  ];
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
    const openRange = this.kpiRangeForCard('open-balance');
    const acceptedRange = this.kpiRangeForCard('accepted-total');
    const expiredRange = this.kpiRangeForCard('expired-count');

    const openSource = this.kpiSourceInvoicesForRange(openRange);
    const acceptedSource = this.kpiSourceInvoicesForRange(acceptedRange);
    const expiredSource = this.kpiSourceInvoicesForRange(expiredRange);

    const openBalance = this.sumByStage(this.openStages, openSource);
    const acceptedTotal = this.sumByStage(this.activeTab() === 'quotes' ? ['accepted'] : ['accepted', 'completed'], acceptedSource);
    const expiredCount = expiredSource.filter(item => item.isExpired).length;

    return [
      {
        id: 'open-balance',
        label: 'Open Balance',
        value: openBalance,
        kind: 'currency',
        tone: 'open',
        range: openRange,
        rangeLabel: this.kpiRangeLabel(openRange)
      },
      {
        id: 'accepted-total',
        label: this.activeTab() === 'quotes' ? 'Accepted Total' : 'Paid Total',
        value: acceptedTotal,
        kind: 'currency',
        tone: 'accepted',
        range: acceptedRange,
        rangeLabel: this.kpiRangeLabel(acceptedRange)
      },
      {
        id: 'expired-count',
        label: 'Expired (30+ days)',
        value: expiredCount,
        kind: 'count',
        tone: 'expired',
        range: expiredRange,
        rangeLabel: this.kpiRangeLabel(expiredRange)
      },
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
  readonly openKpiMenuId = signal<string | null>(null);

  constructor(private readonly router: Router) {
    this.kpiRanges.set(this.readPersistedKpiRanges());
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

  sendNow(invoice: InvoiceCard, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (invoice.stage !== 'draft') return;
    this.closeOpenMenu();
    void this.router.navigate(this.documentRoute(invoice), {
      queryParams: {
        sendNow: '1'
      },
      queryParamsHandling: 'merge'
    });
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

  setKpiRangeForCard(kpiId: string, value: string | null | undefined): void {
    const normalized = String(value || '').trim().toLowerCase();
    const next: KpiRange =
      normalized === 'today' || normalized === 'wtd' || normalized === 'mtd' || normalized === 'ytd' || normalized === 'all'
        ? normalized
        : 'mtd';
    this.kpiRanges.update(current => {
      const existing = this.kpiRangeForCard(kpiId);
      if (existing === next) return current;
      const updated = { ...current, [kpiId]: next };
      this.persistKpiRanges(updated);
      return updated;
    });
    this.openKpiMenuId.set(null);
  }

  toggleKpiMenu(kpiId: string, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.openKpiMenuId.update(current => (current === kpiId ? null : kpiId));
  }

  closeKpiMenu(): void {
    if (this.openKpiMenuId()) this.openKpiMenuId.set(null);
  }

  isKpiMenuOpen(kpiId: string): boolean {
    return this.openKpiMenuId() === kpiId;
  }

  kpiRangeForCard(kpiId: string): KpiRange {
    const raw = this.kpiRanges()[kpiId];
    return raw === 'today' || raw === 'wtd' || raw === 'mtd' || raw === 'ytd' || raw === 'all' ? raw : 'mtd';
  }

  kpiRangeLabel(range: KpiRange): string {
    return this.kpiRangeOptions.find(option => option.id === range)?.label || 'MTD';
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
    const priorCustomerEmailSent = this.invoicesData.hasCustomerFacingEmailHistory(detail);
    if (to && priorCustomerEmailSent) {
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
    } else if (to && priorCustomerEmailSent) {
      await this.showDeleteToast('Quote canceled, but customer email failed to send.', 'danger');
    } else if (to) {
      await this.showDeleteToast('Quote canceled. No prior customer-facing email was sent, so cancellation email was skipped.', 'warning');
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

  private matchesKpiRange(detail: InvoiceDetail, selected: KpiRange): boolean {
    if (selected === 'all') return true;
    const target = this.resolveKpiBasisDate(detail);
    if (!target) return false;
    const start = this.kpiRangeStart(selected, new Date());
    if (!start) return true;
    return target.getTime() >= start.getTime();
  }

  private kpiSourceInvoicesForRange(range: KpiRange): InvoiceCard[] {
    const matchingIds = new Set(
      this.invoicesData
        .invoiceDetails()
        .filter(detail => detail.documentType === this.documentTypeForTab(this.activeTab()))
        .filter(detail => this.matchesKpiRange(detail, range))
        .map(detail => String(detail.id || '').trim())
        .filter(Boolean)
    );
    return this.tabbedInvoices().filter(card => matchingIds.has(String(card.id || '').trim()));
  }

  private resolveKpiBasisDate(detail: InvoiceDetail): Date | null {
    const preferred = String(detail.issueDate || '').trim();
    if (preferred) {
      const dateOnly = new Date(`${preferred}T00:00:00`);
      if (Number.isFinite(dateOnly.getTime())) return dateOnly;
    }
    const fallback = new Date(String(detail.createdAt || detail.updatedAt || '').trim());
    return Number.isFinite(fallback.getTime()) ? fallback : null;
  }

  private kpiRangeStart(range: Exclude<KpiRange, 'all'>, now: Date): Date | null {
    if (!Number.isFinite(now.getTime())) return null;
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    if (range === 'today') return start;
    if (range === 'wtd') {
      const day = start.getDay();
      start.setDate(start.getDate() - day);
      return start;
    }
    if (range === 'mtd') {
      start.setDate(1);
      return start;
    }
    start.setMonth(0, 1);
    return start;
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

  private persistKpiRanges(ranges: Record<string, KpiRange>): void {
    try {
      localStorage.setItem(INVOICES_KPI_RANGE_STORAGE_KEY, JSON.stringify(ranges));
    } catch {
      // Ignore storage failures.
    }
  }

  private readPersistedKpiRanges(): Record<string, KpiRange> {
    try {
      const raw = String(localStorage.getItem(INVOICES_KPI_RANGE_STORAGE_KEY) || '').trim();
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      const out: Record<string, KpiRange> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'today' || normalized === 'wtd' || normalized === 'mtd' || normalized === 'ytd' || normalized === 'all') {
          out[String(key)] = normalized;
        }
      }
      return out;
    } catch {
      return {};
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
      const { rows, timeZone } = await firstValueFrom(forkJoin({
        rows: this.scheduleApi.list(),
        timeZone: this.scheduleApi.getShopTimeZone()
      }));
      const now = Date.now();
      const next = new Set<string>();
      for (const row of Array.isArray(rows) ? rows : []) {
        const customerId = String(row?.customerId || '').trim();
        if (!customerId) continue;
        const endMillis = shopTimeMillis(row.end, timeZone);
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
      appliedIds.push(item.quoteId);
    }

    if (appliedIds.length) {
      this.removePendingQuoteResponses(appliedIds);
    }
  }

  private async syncInvoiceResponses(): Promise<void> {
    try {
      const response = await firstValueFrom(this.invoiceResponseApi.listRecent(250));
      for (const item of response.items || []) {
        if (item.stage !== 'accepted' || !(Number(item.paidAmount) > 0)) continue;
        const existing = this.invoicesData.getInvoiceById(item.invoiceId);
        if (!existing || existing.documentType !== 'invoice') continue;
        const total = Number(existing.total || 0);
        const paid = Number(existing.paidAmount || 0);
        const settledAmount = this.roundCurrency(Number(item.paidAmount));
        if (settledAmount < paid || (settledAmount === paid && existing.stage !== 'sent')) continue;
        const provider = this.normalizeRefundProviderKey(String(item.paymentProvider || ''));
        const transactionId = String(item.paymentTransactionId || '').trim();
        const amount = this.roundCurrency(Number(item.paymentAmount || 0));
        if (['authorize-net', 'paylynx'].includes(provider) && transactionId && amount > 0) {
          this.invoicesData.recordPaymentTransaction(existing.id, {
            provider, amount, transactionId,
            accountNumber: this.maskedAccountForRefund(String(item.paymentAccountNumber || '')),
            createdAt: item.updatedAt
          });
        }
        this.invoicesData.setPaidAmount(existing.id, settledAmount, 'Payment recorded on invoice.', 'customer');
        if (settledAmount >= total && item.paymentKind !== 'final') {
          this.invoicesData.setStage(existing.id, 'accepted', 'Initial invoice paid.', 'customer');
        }
      }
    } catch {
      // Retain the last known state until the server is available.
    }
  }

  private normalizeRefundProviderKey(provider: string): string {
    const normalized = String(provider || '').trim().toLowerCase().replace(/[\s_.]+/g, '-');
    if (!normalized) return '';
    if (normalized === 'authorizenet' || normalized === 'authorize-net' || normalized === 'authorize.net') return 'authorize-net';
    return normalized;
  }

  private maskedAccountForRefund(raw: string): string {
    const digits = String(raw || '').replace(/\D+/g, '');
    if (digits.length < 4) return '';
    return `XXXX${digits.slice(-4)}`;
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


  private roundCurrency(value: number): number {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
  }

}
