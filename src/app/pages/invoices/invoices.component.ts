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
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import {
  INVOICE_LANES,
  InvoiceBoardStage,
  InvoiceCard,
  InvoiceDocumentType,
  InvoiceLane,
  InvoiceStage,
  InvoicesDataService
} from '../../services/invoices-data.service';
import { QuoteResponseApiService } from '../../services/quote-response-api.service';

type InvoiceKpi = {
  id: string;
  label: string;
  value: number;
  kind: 'count' | 'currency';
  tone: 'open' | 'accepted' | 'declined' | 'expired' | 'neutral';
};
type InvoicesTab = 'quotes' | 'invoices';

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
  private readonly toastController = inject(ToastController);
  private readonly laneDisplayOrder: InvoiceBoardStage[] = ['draft', 'sent', 'accepted', 'declined'];
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  readonly lanes = [...INVOICE_LANES].sort(
    (a, b) => this.laneDisplayOrder.indexOf(a.id) - this.laneDisplayOrder.indexOf(b.id)
  );
  readonly activeTab = signal<InvoicesTab>('quotes');
  readonly searchQuery = signal('');
  readonly tabbedInvoices = computed(() => this.invoicesData.invoicesByType(this.documentTypeForTab(this.activeTab())));
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
    const acceptedTotal = this.sumByStage(['accepted'], source);
    const expiredCount = source.filter(item => item.isExpired).length;

    return [
      { id: 'open-balance', label: 'Open Balance', value: openBalance, kind: 'currency', tone: 'open' },
      { id: 'accepted-total', label: 'Accepted Total', value: acceptedTotal, kind: 'currency', tone: 'accepted' },
      { id: 'expired-count', label: 'Expired (30+ days)', value: expiredCount, kind: 'count', tone: 'expired' }
    ];
  });

  readonly laneCards = computed(() => {
    const grouped: Record<InvoiceBoardStage, InvoiceCard[]> = {
      draft: [],
      sent: [],
      accepted: [],
      declined: []
    };
    for (const invoice of this.filteredInvoices()) {
      if (invoice.isExpired) continue;
      if (invoice.stage === 'expired') continue;
      grouped[invoice.stage].push(invoice);
    }
    return grouped;
  });
  readonly deleteDialogOpen = signal(false);
  readonly deleteCandidate = signal<InvoiceCard | null>(null);
  readonly deleteError = signal('');
  readonly openMenuId = signal<string | null>(null);

  constructor(private readonly router: Router) {
    this.route.queryParamMap.subscribe(params => {
      const tab = String(params.get('tab') || '').trim().toLowerCase();
      if (tab === 'invoices') this.activeTab.set('invoices');
      else if (tab === 'quotes') this.activeTab.set('quotes');
    });

    void this.syncQuoteResponses();
    this.syncTimer = setInterval(() => {
      void this.syncQuoteResponses();
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

  trackInvoice(_index: number, invoice: InvoiceCard): string {
    return invoice.id;
  }

  trackKpi(_index: number, kpi: InvoiceKpi): string {
    return kpi.id;
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
    this.openMenuId.set(null);
    this.searchQuery.set('');
  }

  onTabChanged(value: string | null | undefined): void {
    const next = String(value || '').trim().toLowerCase();
    this.setTab(next === 'invoices' ? 'invoices' : 'quotes');
  }

  requestDeleteDraft(invoice: InvoiceCard, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (invoice.documentType !== 'quote' || invoice.stage !== 'draft') return;
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
    const removed = this.invoicesData.deleteDraftQuote(candidate.id);
    if (!removed) {
      this.deleteError.set('Could not delete this draft quote. Please refresh and try again.');
      await this.showDeleteToast('Could not delete this draft quote.', 'danger');
      return;
    }
    this.cancelDeleteDraft();
    await this.showDeleteToast('Quote removed.', 'success');
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

  private documentTypeForTab(tab: InvoicesTab): InvoiceDocumentType {
    return tab === 'quotes' ? 'quote' : 'invoice';
  }

  private async showDeleteToast(message: string, color: 'success' | 'danger'): Promise<void> {
    const toast = await this.toastController.create({
      message,
      color,
      duration: 1800,
      position: 'top'
    });
    await toast.present();
  }

  private async syncQuoteResponses(): Promise<void> {
    try {
      const response = await firstValueFrom(this.quoteResponseApi.listRecent(250));
      const items = Array.isArray(response?.items) ? response.items : [];
      for (const item of items) {
        const quoteId = String(item?.quoteId || '').trim();
        const stage = String(item?.stage || '').trim().toLowerCase();
        if (!quoteId) continue;
        if (stage !== 'accepted' && stage !== 'declined') continue;
        const existing = this.invoicesData.getInvoiceById(quoteId);
        if (!existing || existing.documentType !== 'quote') continue;
        if (existing.stage === stage) continue;
        this.invoicesData.setStage(
          quoteId,
          stage,
          `Customer ${stage === 'accepted' ? 'accepted' : 'declined'} quote from public link.`
        );
      }
    } catch {
      // Silent background sync failure; keeps UI responsive even if endpoint is unavailable.
    }
  }
}
