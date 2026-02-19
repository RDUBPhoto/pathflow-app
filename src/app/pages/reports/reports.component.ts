import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonContent,
  IonHeader,
  IonIcon,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  barChartOutline,
  cashOutline,
  pulseOutline,
  refreshOutline,
  trendingUpOutline
} from 'ionicons/icons';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import {
  ReportsApiService,
  ReportsCommunicationRow,
  ReportsFunnelRow,
  ReportsInvoiceAgingRow,
  ReportsKpiRow,
  ReportsLeadSourceRow,
  ReportsResponse,
  ReportsSalesTrendRow
} from '../../services/reports-api.service';

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [
    CommonModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonContent,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonIcon,
    IonButton,
    IonBadge,
    UserMenuComponent,
    PageBackButtonComponent
  ],
  templateUrl: './reports.component.html',
  styleUrls: ['./reports.component.scss']
})
export default class ReportsComponent implements OnInit {
  private readonly reportsApi = inject(ReportsApiService);

  readonly loading = signal(false);
  readonly error = signal('');
  readonly data = signal<ReportsResponse | null>(null);

  readonly kpi = computed<ReportsKpiRow | null>(() => this.data()?.tables?.kpiSummary?.[0] || null);
  readonly funnel = computed<ReportsFunnelRow[]>(() => this.data()?.tables?.funnel || []);
  readonly trend = computed<ReportsSalesTrendRow[]>(() => this.data()?.tables?.salesTrend || []);
  readonly aging = computed<ReportsInvoiceAgingRow[]>(() => this.data()?.tables?.invoiceAging || []);
  readonly leadSources = computed<ReportsLeadSourceRow[]>(() => this.data()?.tables?.leadSources || []);
  readonly communications = computed<ReportsCommunicationRow[]>(() => this.data()?.tables?.communicationVolume || []);

  constructor() {
    addIcons({
      'bar-chart-outline': barChartOutline,
      'cash-outline': cashOutline,
      'trending-up-outline': trendingUpOutline,
      'pulse-outline': pulseOutline,
      'refresh-outline': refreshOutline
    });
  }

  ngOnInit(): void {
    this.refresh();
  }

  refresh(): void {
    this.loading.set(true);
    this.error.set('');
    this.reportsApi.getPowerBiDataset({ monthsBack: 12, futureDays: 90 }).subscribe({
      next: res => {
        this.data.set(res);
        this.loading.set(false);
      },
      error: err => {
        this.error.set(this.extractError(err, 'Could not load reporting data.'));
        this.loading.set(false);
      }
    });
  }

  formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2
    }).format(value || 0);
  }

  formatPercent(value: number | null): string {
    if (value == null || !Number.isFinite(value)) return '-';
    return `${value.toFixed(1)}%`;
  }

  formatDate(value: string): string {
    const ts = Date.parse(value);
    if (!Number.isFinite(ts)) return value;
    return new Date(ts).toLocaleDateString();
  }

  formatDateTime(value: string): string {
    const ts = Date.parse(value);
    if (!Number.isFinite(ts)) return value;
    return new Date(ts).toLocaleString();
  }

  trackFunnel(_index: number, row: ReportsFunnelRow): string {
    return row.stage_key;
  }

  trackTrend(_index: number, row: ReportsSalesTrendRow): string {
    return row.period_key;
  }

  trackAging(_index: number, row: ReportsInvoiceAgingRow): string {
    return row.bucket_key;
  }

  trackLeadSource(_index: number, row: ReportsLeadSourceRow): string {
    return row.source_key;
  }

  trackComms(_index: number, row: ReportsCommunicationRow): string {
    return `${row.channel}:${row.direction}`;
  }

  private extractError(err: unknown, fallback: string): string {
    if (err instanceof HttpErrorResponse) {
      const detail = typeof err.error === 'object' && err.error !== null
        ? (err.error.detail || err.error.error || err.message)
        : err.message;
      return `${fallback} ${String(detail)}`.trim();
    }
    return fallback;
  }
}
