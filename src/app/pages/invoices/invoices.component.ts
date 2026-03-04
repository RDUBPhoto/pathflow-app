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
  tone: 'open' | 'accepted' | 'declined' | 'expired' | 'neutral';
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
  private readonly laneDisplayOrder: InvoiceStage[] = ['draft', 'sent', 'accepted', 'declined', 'expired'];

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
  readonly openStages: InvoiceStage[] = ['draft', 'sent'];
  readonly kpis = computed<InvoiceKpi[]>(() => {
    const source = this.filteredInvoices();
    const openCount = this.countByStage(this.openStages, source);
    const openBalance = this.sumByStage(this.openStages, source);
    const acceptedCount = this.countByStage(['accepted'], source);
    const acceptedTotal = this.sumByStage(['accepted'], source);
    const declinedCount = this.countByStage(['declined'], source);
    const expiredCount = this.countByStage(['expired'], source);

    return [
      { id: 'open-count', label: 'Open Invoices', value: openCount, kind: 'count', tone: 'open' },
      { id: 'open-balance', label: 'Open Balance', value: openBalance, kind: 'currency', tone: 'open' },
      { id: 'accepted-count', label: 'Accepted', value: acceptedCount, kind: 'count', tone: 'accepted' },
      { id: 'accepted-total', label: 'Accepted Total', value: acceptedTotal, kind: 'currency', tone: 'accepted' },
      { id: 'declined-count', label: 'Declined', value: declinedCount, kind: 'count', tone: 'declined' },
      { id: 'expired-count', label: 'Expired', value: expiredCount, kind: 'count', tone: 'expired' }
    ];
  });

  readonly laneCards = computed(() => {
    const grouped: Record<InvoiceStage, InvoiceCard[]> = {
      draft: [],
      sent: [],
      accepted: [],
      declined: [],
      expired: []
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
