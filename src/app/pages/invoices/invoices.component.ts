import { CommonModule, CurrencyPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular/standalone';
import { Router, RouterLink } from '@angular/router';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { INVOICE_LANES, InvoiceCard, InvoiceLane, InvoiceStage, InvoicesDataService } from '../../services/invoices-data.service';

type InvoiceKpi = {
  id: string;
  label: string;
  value: number;
  kind: 'count' | 'currency';
  tone: 'open' | 'paid' | 'cancelled' | 'neutral';
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
    RouterLink,
    PageBackButtonComponent,
    CompanySwitcherComponent,
    UserMenuComponent
  ],
  templateUrl: './invoices.component.html',
  styleUrls: ['./invoices.component.scss']
})
export default class InvoicesComponent {
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly laneDisplayOrder: InvoiceStage[] = ['draft', 'approved', 'sent', 'paid', 'cancelled'];

  readonly lanes = [...INVOICE_LANES].sort(
    (a, b) => this.laneDisplayOrder.indexOf(a.id) - this.laneDisplayOrder.indexOf(b.id)
  );
  readonly invoices = this.invoicesData.invoices;
  readonly searchQuery = signal('');
  readonly filteredInvoices = computed(() => {
    const query = this.searchQuery().trim().toLowerCase();
    if (!query) return this.invoices();

    return this.invoices().filter(invoice => {
      const amountText = invoice.total.toFixed(2);
      const haystack = [
        invoice.customerName,
        invoice.invoiceNumber,
        invoice.vehicle,
        invoice.template,
        invoice.invoicedAt,
        amountText
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  });
  readonly openStages: InvoiceStage[] = ['draft', 'approved', 'sent'];
  readonly kpis = computed<InvoiceKpi[]>(() => {
    const source = this.filteredInvoices();
    const openCount = this.countByStage(this.openStages, source);
    const openBalance = this.sumByStage(this.openStages, source);
    const paidCount = this.countByStage(['paid'], source);
    const paidTotal = this.sumByStage(['paid'], source);
    const cancelledCount = this.countByStage(['cancelled'], source);

    return [
      { id: 'open-count', label: 'Open Invoices', value: openCount, kind: 'count', tone: 'open' },
      { id: 'open-balance', label: 'Open Balance', value: openBalance, kind: 'currency', tone: 'open' },
      { id: 'paid-count', label: 'Paid Invoices', value: paidCount, kind: 'count', tone: 'paid' },
      { id: 'paid-total', label: 'Paid Total', value: paidTotal, kind: 'currency', tone: 'paid' },
      { id: 'cancelled-count', label: 'Cancelled', value: cancelledCount, kind: 'count', tone: 'cancelled' }
    ];
  });

  readonly laneCards = computed(() => {
    const grouped: Record<InvoiceStage, InvoiceCard[]> = {
      draft: [],
      approved: [],
      sent: [],
      paid: [],
      cancelled: []
    };
    for (const invoice of this.filteredInvoices()) {
      grouped[invoice.stage].push(invoice);
    }
    return grouped;
  });

  constructor(private readonly router: Router) {}

  openTemplatePicker(): void {
    this.router.navigate(['/invoices/new']);
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

  private countByStage(stages: InvoiceStage[], source: InvoiceCard[]): number {
    const stageSet = new Set(stages);
    return source.reduce((count, invoice) => (stageSet.has(invoice.stage) ? count + 1 : count), 0);
  }

  private sumByStage(stages: InvoiceStage[], source: InvoiceCard[]): number {
    const stageSet = new Set(stages);
    return source.reduce((sum, invoice) => (stageSet.has(invoice.stage) ? sum + invoice.total : sum), 0);
  }
}
