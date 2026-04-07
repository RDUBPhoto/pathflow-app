import { CommonModule } from '@angular/common';
import { Component, OnInit, AfterViewInit, OnDestroy, ElementRef, ViewChild, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
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
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import {
  ReportsApiService,
  ReportsCashflowForecastRow,
  ReportsCommunicationRow,
  ReportsFunnelRow,
  ReportsInvoiceAgingRow,
  ReportsKpiRow,
  ReportsLeadSourceRow,
  PowerBiConfigResponse,
  ReportsProductionForecastRow,
  ReportsResponse,
  ReportsSeedDemoResponse,
  ReportsSalesTrendRow
} from '../../services/reports-api.service';
import { environment } from '../../../environments/environment';
import * as powerbi from 'powerbi-client';

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
    PageBackButtonComponent,
    CompanySwitcherComponent
  ],
  templateUrl: './reports.component.html',
  styleUrls: ['./reports.component.scss']
})
export default class ReportsComponent implements OnInit, AfterViewInit, OnDestroy {
  readonly pageSize = 12;
  private readonly reportsApi = inject(ReportsApiService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly powerBiService = new powerbi.service.Service(
    powerbi.factories.hpmFactory,
    powerbi.factories.wpmpFactory,
    powerbi.factories.routerFactory
  );
  private powerBiReport: powerbi.Report | null = null;
  private powerBiHostEl: HTMLDivElement | null = null;
  private viewInitialized = false;

  readonly reportView = signal<
    | 'all'
    | 'overview'
    | 'funnel'
    | 'invoice-aging'
    | 'lead-sources'
    | 'communications'
    | 'sales-trend'
    | 'production-forecast'
    | 'cashflow-forecast'
  >('all');
  readonly loading = signal(false);
  readonly error = signal('');
  readonly info = signal('');
  readonly forecastMonths = signal(6);
  readonly openingCash = signal(0);
  readonly data = signal<ReportsResponse | null>(null);
  readonly powerBi = signal<PowerBiConfigResponse['powerBi'] | null>(null);
  readonly powerBiLoading = signal(false);
  readonly powerBiWebUrl = signal<SafeResourceUrl | null>(null);
  readonly seeding = signal(false);
  readonly demoToolsEnabled = !!environment.features?.demoTools;
  readonly trendPage = signal(1);
  readonly productionForecastPage = signal(1);
  readonly cashflowForecastPage = signal(1);

  readonly kpi = computed<ReportsKpiRow | null>(() => this.data()?.tables?.kpiSummary?.[0] || null);
  readonly funnel = computed<ReportsFunnelRow[]>(() => this.data()?.tables?.funnel || []);
  readonly trend = computed<ReportsSalesTrendRow[]>(() => this.data()?.tables?.salesTrend || []);
  readonly aging = computed<ReportsInvoiceAgingRow[]>(() => this.data()?.tables?.invoiceAging || []);
  readonly leadSources = computed<ReportsLeadSourceRow[]>(() => this.data()?.tables?.leadSources || []);
  readonly communications = computed<ReportsCommunicationRow[]>(() => this.data()?.tables?.communicationVolume || []);
  readonly productionForecast = computed<ReportsProductionForecastRow[]>(
    () => this.data()?.tables?.productionForecast || []
  );
  readonly cashflowForecast = computed<ReportsCashflowForecastRow[]>(
    () => this.data()?.tables?.cashflowForecast || []
  );
  readonly trendTotalPages = computed(() => Math.max(1, Math.ceil(this.trend().length / this.pageSize)));
  readonly productionForecastTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.productionForecast().length / this.pageSize))
  );
  readonly cashflowForecastTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.cashflowForecast().length / this.pageSize))
  );
  readonly pagedTrend = computed(() => {
    const page = Math.max(1, Math.min(this.trendPage(), this.trendTotalPages()));
    const start = (page - 1) * this.pageSize;
    return this.trend().slice(start, start + this.pageSize);
  });
  readonly pagedProductionForecast = computed(() => {
    const page = Math.max(1, Math.min(this.productionForecastPage(), this.productionForecastTotalPages()));
    const start = (page - 1) * this.pageSize;
    return this.productionForecast().slice(start, start + this.pageSize);
  });
  readonly pagedCashflowForecast = computed(() => {
    const page = Math.max(1, Math.min(this.cashflowForecastPage(), this.cashflowForecastTotalPages()));
    const start = (page - 1) * this.pageSize;
    return this.cashflowForecast().slice(start, start + this.pageSize);
  });
  readonly powerBiMissingKeys = computed(() => this.powerBi()?.missingSecureKeys || []);

  @ViewChild('powerBiEmbedHost')
  set powerBiEmbedHost(ref: ElementRef<HTMLDivElement> | undefined) {
    this.powerBiHostEl = ref?.nativeElement || null;
    this.renderPowerBiSecureEmbed();
  }

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
    this.loadPowerBiConfig();
  }

  ngAfterViewInit(): void {
    this.viewInitialized = true;
    this.renderPowerBiSecureEmbed();
  }

  ngOnDestroy(): void {
    this.resetPowerBiEmbed();
  }

  refresh(): void {
    this.loading.set(true);
    this.error.set('');
    this.reportsApi.getPowerBiDataset({
      monthsBack: 12,
      futureDays: 90,
      forecastMonths: this.forecastMonths(),
      openingCash: this.openingCash()
    }).subscribe({
      next: res => {
        this.data.set(res);
        this.trendPage.set(1);
        this.productionForecastPage.set(1);
        this.cashflowForecastPage.set(1);
        this.loading.set(false);
      },
      error: err => {
        this.error.set(this.extractError(err, 'Could not load reporting data.'));
        this.loading.set(false);
      }
    });
  }

  seedDemoData(): void {
    if (!this.demoToolsEnabled) return;
    if (this.seeding()) return;
    this.seeding.set(true);
    this.error.set('');
    this.info.set('');
    this.reportsApi.seedDemoData().subscribe({
      next: (res: ReportsSeedDemoResponse) => {
        this.info.set(
          `${res.message} Seeded ${res.workItemsSeeded} work items and ${res.invoicesSeeded} invoices.`
        );
        this.seeding.set(false);
        this.refresh();
      },
      error: err => {
        this.error.set(this.extractError(err, 'Could not seed demo reporting data.'));
        this.seeding.set(false);
      }
    });
  }

  loadPowerBiConfig(): void {
    this.powerBiLoading.set(true);
    this.reportsApi.getPowerBiConfig(false).subscribe({
      next: res => {
        this.powerBi.set(res.powerBi || null);
        this.powerBiWebUrl.set(this.buildPowerBiWebUrl(res.powerBi || null));
        this.powerBiLoading.set(false);
        if (res.powerBi?.secureEmbedReady || res.powerBi?.webEmbedReady) {
          this.loadPowerBiEmbedConfig();
        } else {
          this.resetPowerBiEmbed();
        }
      },
      error: () => {
        this.powerBi.set(null);
        this.powerBiWebUrl.set(null);
        this.powerBiLoading.set(false);
        this.resetPowerBiEmbed();
      }
    });
  }

  private loadPowerBiEmbedConfig(): void {
    this.powerBiLoading.set(true);
    this.reportsApi.getPowerBiEmbedConfig(true).subscribe({
      next: res => {
        this.powerBi.set(res.powerBi || null);
        this.powerBiWebUrl.set(this.buildPowerBiWebUrl(res.powerBi || null));
        this.powerBiLoading.set(false);
        this.renderPowerBiSecureEmbed();
      },
      error: err => {
        this.powerBiLoading.set(false);
        this.powerBiWebUrl.set(this.buildPowerBiWebUrl(this.powerBi()));
        this.resetPowerBiEmbed();
        this.error.set(this.extractError(err, 'Could not load Power BI embed configuration.'));
      }
    });
  }

  private buildPowerBiWebUrl(pbi: PowerBiConfigResponse['powerBi'] | null): SafeResourceUrl | null {
    if (!pbi) return null;
    const raw = this.toPowerBiWebEmbedUrl(pbi);
    if (!raw) return null;
    return this.sanitizer.bypassSecurityTrustResourceUrl(raw);
  }

  private toPowerBiWebEmbedUrl(pbi: PowerBiConfigResponse['powerBi'] | null): string {
    if (!pbi) return '';
    const reportWebUrl = String(pbi.reportWebUrl || '').trim();
    const workspaceId = String(pbi.workspaceId || '').trim();
    const reportId = String(pbi.reportId || '').trim();
    const tenantId = String(pbi.tenantId || '').trim();
    const fallbackHost = 'https://app.powerbi.com';

    if (workspaceId && reportId) {
      const url = new URL('/reportEmbed', fallbackHost);
      url.searchParams.set('groupId', workspaceId);
      url.searchParams.set('reportId', reportId);
      url.searchParams.set('autoAuth', 'true');
      if (tenantId) url.searchParams.set('ctid', tenantId);
      url.searchParams.set('navContentPaneEnabled', 'false');
      return url.toString();
    }

    if (!reportWebUrl) return '';
    try {
      const parsed = new URL(reportWebUrl);
      const host = String(parsed.hostname || '').toLowerCase();
      if (!host.endsWith('powerbi.com')) return '';
      if (parsed.pathname.toLowerCase().includes('/reportembed')) {
        if (!parsed.searchParams.has('navContentPaneEnabled')) {
          parsed.searchParams.set('navContentPaneEnabled', 'false');
        }
        return parsed.toString();
      }

      const parts = parsed.pathname.split('/').filter(Boolean);
      const groupsIndex = parts.findIndex(segment => segment.toLowerCase() === 'groups');
      const reportsIndex = parts.findIndex(segment => segment.toLowerCase() === 'reports');
      const groupId = groupsIndex >= 0 ? String(parts[groupsIndex + 1] || '').trim() : '';
      const inferredReportId = reportsIndex >= 0 ? String(parts[reportsIndex + 1] || '').trim() : '';
      if (groupId && inferredReportId) {
        const embed = new URL('/reportEmbed', `${parsed.protocol}//${parsed.host}`);
        embed.searchParams.set('groupId', groupId);
        embed.searchParams.set('reportId', inferredReportId);
        embed.searchParams.set('autoAuth', 'true');
        if (tenantId) embed.searchParams.set('ctid', tenantId);
        embed.searchParams.set('navContentPaneEnabled', 'false');
        return embed.toString();
      }
      return '';
    } catch {
      return '';
    }
  }

  private renderPowerBiSecureEmbed(): void {
    if (!this.viewInitialized || !this.powerBiHostEl) return;
    const pbi = this.powerBi();
    this.resetPowerBiEmbed();
    if (!pbi || pbi.mode !== 'secure-embed') return;
    if (!pbi.embedUrl || !pbi.embedToken || !pbi.reportId) return;

    const embedConfig: powerbi.IReportEmbedConfiguration = {
      type: 'report',
      tokenType: powerbi.models.TokenType.Embed,
      accessToken: pbi.embedToken,
      embedUrl: pbi.embedUrl,
      id: pbi.reportId,
      permissions: powerbi.models.Permissions.Read,
      settings: {
        panes: {
          filters: { visible: false },
          pageNavigation: { visible: true }
        },
        background: powerbi.models.BackgroundType.Transparent
      }
    };

    this.powerBiReport = this.powerBiService.embed(this.powerBiHostEl, embedConfig) as powerbi.Report;
    this.powerBiReport.off('error');
    this.powerBiReport.on('error', (event: any) => {
      const detail = String(event?.detail?.message || event?.message || '').trim();
      this.error.set(detail ? `Power BI embed error: ${detail}` : 'Power BI embed error.');
    });
  }

  private resetPowerBiEmbed(): void {
    if (!this.powerBiHostEl) {
      this.powerBiReport = null;
      return;
    }
    this.powerBiService.reset(this.powerBiHostEl);
    this.powerBiReport = null;
  }

  downloadCurrentReport(): void {
    const payload = this.data();
    if (!payload) return;
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate()
    ).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const view = this.reportView();

    if (view === 'all') {
      this.downloadBlob(
        `reports-dataset-${stamp}.json`,
        JSON.stringify(payload, null, 2),
        'application/json;charset=utf-8'
      );
      return;
    }

    const rows = this.rowsForView(view);
    const csv = this.toCsv(rows);
    this.downloadBlob(`reports-${view}-${stamp}.csv`, csv, 'text/csv;charset=utf-8');
  }

  updateReportView(value: string): void {
    const normalized = (value || '').trim() as
      | 'all'
      | 'overview'
      | 'funnel'
      | 'invoice-aging'
      | 'lead-sources'
      | 'communications'
      | 'sales-trend'
      | 'production-forecast'
      | 'cashflow-forecast';
    const allowed = new Set([
      'all',
      'overview',
      'funnel',
      'invoice-aging',
      'lead-sources',
      'communications',
      'sales-trend',
      'production-forecast',
      'cashflow-forecast'
    ]);
    if (!allowed.has(normalized)) return;
    this.reportView.set(normalized);
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

  trackProductionForecast(_index: number, row: ReportsProductionForecastRow): string {
    return row.period_key;
  }

  trackCashflowForecast(_index: number, row: ReportsCashflowForecastRow): string {
    return row.period_key;
  }

  prevTrendPage(): void {
    this.trendPage.update(value => Math.max(1, value - 1));
  }

  nextTrendPage(): void {
    this.trendPage.update(value => Math.min(this.trendTotalPages(), value + 1));
  }

  prevProductionForecastPage(): void {
    this.productionForecastPage.update(value => Math.max(1, value - 1));
  }

  nextProductionForecastPage(): void {
    this.productionForecastPage.update(value => Math.min(this.productionForecastTotalPages(), value + 1));
  }

  prevCashflowForecastPage(): void {
    this.cashflowForecastPage.update(value => Math.max(1, value - 1));
  }

  nextCashflowForecastPage(): void {
    this.cashflowForecastPage.update(value => Math.min(this.cashflowForecastTotalPages(), value + 1));
  }

  private rowsForView(
    view:
      | 'overview'
      | 'funnel'
      | 'invoice-aging'
      | 'lead-sources'
      | 'communications'
      | 'sales-trend'
      | 'production-forecast'
      | 'cashflow-forecast'
  ): Record<string, unknown>[] {
    switch (view) {
      case 'overview': {
        const row = this.kpi();
        return row ? [row] : [];
      }
      case 'funnel':
        return this.funnel();
      case 'invoice-aging':
        return this.aging();
      case 'lead-sources':
        return this.leadSources();
      case 'communications':
        return this.communications();
      case 'sales-trend':
        return this.trend();
      case 'production-forecast':
        return this.productionForecast();
      case 'cashflow-forecast':
        return this.cashflowForecast();
      default:
        return [];
    }
  }

  private toCsv(rows: Record<string, unknown>[]): string {
    if (!rows.length) return 'No data\n';
    const keys = Array.from(
      rows.reduce<Set<string>>((acc, row) => {
        Object.keys(row || {}).forEach(key => acc.add(key));
        return acc;
      }, new Set<string>())
    );

    const escapeCsv = (value: unknown): string => {
      if (value == null) return '';
      const stringValue = String(value);
      if (/[",\r\n]/.test(stringValue)) {
        return `"${stringValue.replace(/"/g, '""')}"`;
      }
      return stringValue;
    };

    const header = keys.map(escapeCsv).join(',');
    const lines = rows.map(row => keys.map(key => escapeCsv((row as Record<string, unknown>)[key])).join(','));
    return [header, ...lines].join('\n');
  }

  private downloadBlob(filename: string, content: string, mimeType: string): void {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
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
