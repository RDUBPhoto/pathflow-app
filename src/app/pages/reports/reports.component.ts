import { CommonModule } from '@angular/common';
import { Component, OnInit, AfterViewInit, OnDestroy, ElementRef, ViewChild, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Params, RouterLink } from '@angular/router';
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
  calendarOutline,
  cashOutline,
  constructOutline,
  informationCircleOutline,
  pulseOutline,
  refreshOutline,
  statsChartOutline,
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
  ReportsJobTimingRow,
  ReportsKpiRow,
  ReportsLeadSourceRow,
  PowerBiConfigResponse,
  ReportsProductionForecastRow,
  ReportsResponse,
  ReportsSeedDemoResponse,
  ReportsSalesTrendRow
} from '../../services/reports-api.service';
import { InvoiceDetail, InvoicesDataService } from '../../services/invoices-data.service';
import { InventoryApiService, InventoryItem } from '../../services/inventory-api.service';
import { AppSettingsApiService } from '../../services/app-settings-api.service';
import { WorkItem, WorkItemsApi } from '../../services/workitems-api.service';
import { environment } from '../../../environments/environment';
import * as powerbi from 'powerbi-client';

const BUSINESS_LABOR_RATES_SETTING_KEY = 'business.labor.rates';
const SCHEDULE_SETTINGS_KEY = 'schedule.settings';

type ScheduleSettings = {
  openHour: number;
  closeHour: number;
  showWeekends: boolean;
};

const DEFAULT_SCHEDULE_SETTINGS: ScheduleSettings = {
  openHour: 7,
  closeHour: 16,
  showWeekends: false
};

type LaborRateSetting = {
  id: string;
  name: string;
  price: number;
  taxable: boolean;
  cost: number;
};

type JobProfitMatrixRow = {
  key: string;
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  soldDateIso: string;
  soldDateLabel: string;
  partSold: number;
  partCost: number;
  laborSold: number;
  laborCost: number;
  totalSold: number;
  totalCost: number;
  grossProfit: number;
  marginPct: number;
  billedHours: number;
  actualHours: number;
  hoursVariance: number;
  laborVarianceValue: number;
  varianceDirection: 'under' | 'over' | 'even' | 'unknown';
  matchedWorkItemId: string;
  matchedWorkItemTitle: string;
};

type LaborVarianceSummary = {
  jobsWithBilledHours: number;
  jobsWithTrackedHours: number;
  jobsMissingTrackedHours: number;
  billedHoursTotal: number;
  actualHoursTotal: number;
  overHoursTotal: number;
  underHoursTotal: number;
  netHoursVariance: number;
  estimatedNetVarianceValue: number;
};

type ReportsWarning = {
  message: string;
  details?: string[];
  moreCount?: number;
  actionLabel?: string;
  link?: string;
  queryParams?: Params;
};

type MissingCostLine = {
  invoiceNumber: string;
  code: string;
  description: string;
};

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
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
    UserMenuComponent,
    PageBackButtonComponent,
    CompanySwitcherComponent
  ],
  templateUrl: './reports.component.html',
  styleUrls: ['./reports.component.scss']
})
export default class ReportsComponent implements OnInit, AfterViewInit, OnDestroy {
  private static readonly MS_PER_HOUR = 60 * 60 * 1000;
  readonly pageSize = 12;
  readonly powerBiEnabled = !!environment.features?.powerBiReports;
  private readonly reportsApi = inject(ReportsApiService);
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly inventoryApi = inject(InventoryApiService);
  private readonly settingsApi = inject(AppSettingsApiService);
  private readonly workItemsApi = inject(WorkItemsApi);
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
  readonly periodStart = signal('');
  readonly periodEnd = signal('');
  readonly loading = signal(false);
  readonly error = signal('');
  readonly info = signal('');
  readonly forecastMonths = signal<'3' | '6' | '9' | '12'>('3');
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
  readonly inventoryItems = signal<InventoryItem[]>([]);
  readonly workItems = signal<WorkItem[]>([]);
  readonly laborRates = signal<LaborRateSetting[]>([]);
  readonly scheduleSettings = signal<ScheduleSettings>({ ...DEFAULT_SCHEDULE_SETTINGS });

  readonly kpi = computed<ReportsKpiRow | null>(() => this.data()?.tables?.kpiSummary?.[0] || null);
  readonly localInvoices = computed(() =>
    this.invoicesData.invoiceDetails().filter(item => item.documentType === 'invoice')
  );
  readonly localQuotes = computed(() =>
    this.invoicesData.invoiceDetails().filter(item => item.documentType === 'quote')
  );
  readonly soldInvoicesInPeriod = computed(() => {
    const filters = this.data()?.filters;
    const periodStart = this.parseAsDate(filters?.periodStart);
    const periodEnd = this.parseAsDate(filters?.periodEnd);
    return this.localInvoices().filter(invoice => {
      if (!this.isSoldInvoice(invoice)) return false;
      if (!periodStart || !periodEnd) return true;
      const effectiveDate = this.invoiceDate(invoice);
      if (!effectiveDate) return false;
      return this.isDateInRange(effectiveDate, periodStart, periodEnd);
    });
  });
  readonly inventorySkuMap = computed(() => {
    const map = new Map<string, InventoryItem>();
    for (const item of this.inventoryItems()) {
      const key = this.normalizeKey(item?.sku);
      if (!key) continue;
      if (!map.has(key)) map.set(key, item);
    }
    return map;
  });
  readonly inventoryNameMap = computed(() => {
    const map = new Map<string, InventoryItem>();
    for (const item of this.inventoryItems()) {
      const key = this.normalizeKey(item?.name);
      if (!key) continue;
      if (!map.has(key)) map.set(key, item);
    }
    return map;
  });
  readonly laborRateIdMap = computed(() => {
    const map = new Map<string, LaborRateSetting>();
    for (const item of this.laborRates()) {
      const key = this.normalizeKey(item?.id);
      if (!key) continue;
      if (!map.has(key)) map.set(key, item);
    }
    return map;
  });
  readonly laborRateNameMap = computed(() => {
    const map = new Map<string, LaborRateSetting>();
    for (const item of this.laborRates()) {
      const key = this.normalizeKey(item?.name);
      if (!key) continue;
      if (!map.has(key)) map.set(key, item);
    }
    return map;
  });
  readonly unitEconomics = computed(() => {
    let partRevenue = 0;
    let partCost = 0;
    let laborRevenue = 0;
    let laborCost = 0;
    let partUnknownCostLines = 0;
    let laborUnknownCostLines = 0;
    let laborBilledUnits = 0;
    const missingPartLines: MissingCostLine[] = [];
    const missingLaborLines: MissingCostLine[] = [];

    for (const invoice of this.soldInvoicesInPeriod()) {
      const invoiceNumber = String(invoice.invoiceNumber || invoice.id || '').trim() || 'Unknown invoice';
      for (const line of invoice.lineItems || []) {
        const quantity = Math.max(0, Number(line.quantity || 0));
        const lineRevenue = Math.max(
          0,
          Number(line.lineSubtotal || (quantity * Number(line.unitPrice || 0)) || 0)
        );
        const type = String(line.type || '').toLowerCase() === 'labor' ? 'labor' : 'part';

        if (type === 'part') {
          partRevenue += lineRevenue;
          const unitCost = this.resolvePartUnitCost(line.code, line.description);
          if (unitCost > 0) {
            partCost += quantity * unitCost;
          } else if (lineRevenue > 0) {
            partUnknownCostLines += 1;
            missingPartLines.push({
              invoiceNumber,
              code: String(line.code || '').trim(),
              description: String(line.description || '').trim()
            });
          }
          continue;
        }

        laborRevenue += lineRevenue;
        laborBilledUnits += quantity;
        const unitCost = this.resolveLaborUnitCost(line.code, line.description);
        if (unitCost > 0) {
          laborCost += quantity * unitCost;
        } else if (lineRevenue > 0) {
          laborUnknownCostLines += 1;
          missingLaborLines.push({
            invoiceNumber,
            code: String(line.code || '').trim(),
            description: String(line.description || '').trim()
          });
        }
      }
    }

    const totalRevenue = partRevenue + laborRevenue;
    const totalCost = partCost + laborCost;
    const partGrossProfit = partRevenue - partCost;
    const laborGrossProfit = laborRevenue - laborCost;
    const totalGrossProfit = totalRevenue - totalCost;

    const partMarginPct = partRevenue > 0 ? (partGrossProfit / partRevenue) * 100 : 0;
    const laborMarginPct = laborRevenue > 0 ? (laborGrossProfit / laborRevenue) * 100 : 0;
    const totalMarginPct = totalRevenue > 0 ? (totalGrossProfit / totalRevenue) * 100 : 0;

    return {
      invoiceCount: this.soldInvoicesInPeriod().length,
      partRevenue: this.roundAmount(partRevenue),
      partCost: this.roundAmount(partCost),
      partGrossProfit: this.roundAmount(partGrossProfit),
      partMarginPct: this.roundAmount(partMarginPct),
      laborRevenue: this.roundAmount(laborRevenue),
      laborCost: this.roundAmount(laborCost),
      laborGrossProfit: this.roundAmount(laborGrossProfit),
      laborMarginPct: this.roundAmount(laborMarginPct),
      totalRevenue: this.roundAmount(totalRevenue),
      totalCost: this.roundAmount(totalCost),
      totalGrossProfit: this.roundAmount(totalGrossProfit),
      totalMarginPct: this.roundAmount(totalMarginPct),
      partUnknownCostLines,
      laborUnknownCostLines,
      laborBilledUnits: this.roundAmount(laborBilledUnits),
      missingPartLines,
      missingLaborLines
    };
  });
  readonly jobProfitMatrixRows = computed<JobProfitMatrixRow[]>(() => {
    const rows: JobProfitMatrixRow[] = [];
    for (const invoice of this.soldInvoicesInPeriod()) {
      const soldDate = this.invoiceDate(invoice);
      const matchedWorkItem = this.matchWorkItemForInvoice(invoice, soldDate);
      const actualHours = this.roundAmount(this.computeActualWorkedHours(matchedWorkItem));

      let partSold = 0;
      let partCost = 0;
      let laborSold = 0;
      let laborBilledCost = 0;
      let laborKnownCostHours = 0;
      let laborSellValue = 0;
      let laborSellHours = 0;
      let billedHours = 0;

      for (const line of invoice.lineItems || []) {
        const quantity = Math.max(0, Number(line.quantity || 0));
        const lineRevenue = Math.max(
          0,
          Number(line.lineSubtotal || (quantity * Number(line.unitPrice || 0)) || 0)
        );
        const lineType = String(line.type || '').toLowerCase() === 'labor' ? 'labor' : 'part';

        if (lineType === 'part') {
          partSold += lineRevenue;
          const unitCost = this.resolvePartUnitCost(line.code, line.description);
          if (unitCost > 0) partCost += quantity * unitCost;
          continue;
        }

        laborSold += lineRevenue;
        billedHours += quantity;
        if (quantity > 0 && lineRevenue > 0) {
          laborSellValue += lineRevenue;
          laborSellHours += quantity;
        }
        const unitCost = this.resolveLaborUnitCost(line.code, line.description);
        if (unitCost > 0) {
          laborBilledCost += quantity * unitCost;
          laborKnownCostHours += quantity;
        }
      }

      const laborHourlyCost = laborKnownCostHours > 0 ? (laborBilledCost / laborKnownCostHours) : 0;
      const laborCost = actualHours > 0 && laborHourlyCost > 0
        ? (actualHours * laborHourlyCost)
        : laborBilledCost;
      const hoursVariance = actualHours > 0 && billedHours > 0 ? (actualHours - billedHours) : 0;
      const laborSellRate = laborSellHours > 0 ? (laborSellValue / laborSellHours) : 0;
      const laborVarianceValue = hoursVariance * laborSellRate;
      const totalSold = partSold + laborSold;
      const totalCost = partCost + laborCost;
      const grossProfit = totalSold - totalCost;
      const marginPct = totalSold > 0 ? ((grossProfit / totalSold) * 100) : 0;

      const varianceDirection: JobProfitMatrixRow['varianceDirection'] =
        billedHours <= 0 || actualHours <= 0
          ? 'unknown'
          : Math.abs(hoursVariance) < 0.01
            ? 'even'
            : hoursVariance > 0
              ? 'over'
              : 'under';

      rows.push({
        key: String(invoice.id || invoice.invoiceNumber || Math.random()),
        invoiceId: String(invoice.id || ''),
        invoiceNumber: String(invoice.invoiceNumber || ''),
        customerName: String(invoice.customerName || '').trim() || 'Customer',
        soldDateIso: soldDate?.toISOString() || '',
        soldDateLabel: soldDate ? soldDate.toLocaleDateString() : '-',
        partSold: this.roundAmount(partSold),
        partCost: this.roundAmount(partCost),
        laborSold: this.roundAmount(laborSold),
        laborCost: this.roundAmount(laborCost),
        totalSold: this.roundAmount(totalSold),
        totalCost: this.roundAmount(totalCost),
        grossProfit: this.roundAmount(grossProfit),
        marginPct: this.roundAmount(marginPct),
        billedHours: this.roundAmount(billedHours),
        actualHours: this.roundAmount(actualHours),
        hoursVariance: this.roundAmount(hoursVariance),
        laborVarianceValue: this.roundAmount(laborVarianceValue),
        varianceDirection,
        matchedWorkItemId: String(matchedWorkItem?.id || ''),
        matchedWorkItemTitle: String(matchedWorkItem?.title || '')
      });
    }

    rows.sort((a, b) => {
      const aTs = Date.parse(a.soldDateIso || '');
      const bTs = Date.parse(b.soldDateIso || '');
      if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) return bTs - aTs;
      return b.totalSold - a.totalSold;
    });
    return rows;
  });
  readonly topJobProfitRows = computed(() => this.jobProfitMatrixRows().slice(0, 30));
  readonly additionalJobProfitRows = computed(() =>
    Math.max(0, this.jobProfitMatrixRows().length - this.topJobProfitRows().length)
  );
  readonly laborVarianceRows = computed(() => this.topJobProfitRows().filter(row => row.billedHours > 0));
  readonly laborVarianceSummary = computed<LaborVarianceSummary>(() => {
    const rows = this.jobProfitMatrixRows().filter(row => row.billedHours > 0);
    let jobsWithTrackedHours = 0;
    let jobsMissingTrackedHours = 0;
    let billedHoursTotal = 0;
    let actualHoursTotal = 0;
    let overHoursTotal = 0;
    let underHoursTotal = 0;
    let estimatedNetVarianceValue = 0;

    for (const row of rows) {
      billedHoursTotal += row.billedHours;
      estimatedNetVarianceValue += row.laborVarianceValue;
      if (row.actualHours > 0) {
        jobsWithTrackedHours += 1;
        actualHoursTotal += row.actualHours;
        if (row.hoursVariance > 0) overHoursTotal += row.hoursVariance;
        if (row.hoursVariance < 0) underHoursTotal += Math.abs(row.hoursVariance);
      } else {
        jobsMissingTrackedHours += 1;
      }
    }

    const netHoursVariance = actualHoursTotal - billedHoursTotal;
    return {
      jobsWithBilledHours: rows.length,
      jobsWithTrackedHours,
      jobsMissingTrackedHours,
      billedHoursTotal: this.roundAmount(billedHoursTotal),
      actualHoursTotal: this.roundAmount(actualHoursTotal),
      overHoursTotal: this.roundAmount(overHoursTotal),
      underHoursTotal: this.roundAmount(underHoursTotal),
      netHoursVariance: this.roundAmount(netHoursVariance),
      estimatedNetVarianceValue: this.roundAmount(estimatedNetVarianceValue)
    };
  });
  readonly forecastScheduledJobs = computed(() =>
    this.nextProductionRows().reduce((sum, row) => sum + Math.max(0, Number(row.scheduled_jobs || 0)), 0)
  );
  readonly forecastPipelineJobs = computed(() =>
    this.nextProductionRows().reduce((sum, row) => sum + Math.max(0, Number(row.pipeline_items || 0)), 0)
  );
  readonly forecastLaborAccuracyRatio = computed(() => {
    const summary = this.laborVarianceSummary();
    if (summary.billedHoursTotal <= 0 || summary.actualHoursTotal <= 0) return 1;
    return this.roundAmount(summary.actualHoursTotal / summary.billedHoursTotal);
  });
  readonly forecastLaborAccuracyPct = computed(() =>
    this.roundAmount(this.forecastLaborAccuracyRatio() * 100)
  );
  readonly forecastLaborAccuracyLabel = computed(() => {
    const ratio = this.forecastLaborAccuracyRatio();
    if (ratio > 1.02) return 'Running over estimated labor time';
    if (ratio < 0.98) return 'Running under estimated labor time';
    return 'Labor time tracking is on target';
  });
  readonly forecastLaborSellRate = computed(() => {
    const economics = this.unitEconomics();
    if (economics.laborRevenue > 0 && economics.laborBilledUnits > 0) {
      return this.roundAmount(economics.laborRevenue / economics.laborBilledUnits);
    }
    const pricedRates = this.laborRates()
      .map(rate => Math.max(0, Number(rate.price || 0)))
      .filter(price => price > 0);
    if (pricedRates.length > 0) {
      const average = pricedRates.reduce((sum, price) => sum + price, 0) / pricedRates.length;
      return this.roundAmount(average);
    }
    return 0;
  });
  readonly forecastLaborRevenueShare = computed(() => {
    const economics = this.unitEconomics();
    if (economics.totalRevenue > 0 && economics.laborRevenue > 0) {
      return Math.min(0.9, Math.max(0.1, economics.laborRevenue / economics.totalRevenue));
    }
    return 0.35;
  });
  readonly forecastLaborRevenue = computed(() =>
    this.roundAmount(this.projectedRevenueTotal() * this.forecastLaborRevenueShare())
  );
  readonly forecastLaborHoursPlanned = computed(() => {
    const rate = this.forecastLaborSellRate();
    if (rate <= 0) return 0;
    return this.roundAmount(this.forecastLaborRevenue() / rate);
  });
  readonly forecastLaborHoursAdjusted = computed(() =>
    this.roundAmount(this.forecastLaborHoursPlanned() * this.forecastLaborAccuracyRatio())
  );
  readonly economicsWarnings = computed<ReportsWarning[]>(() => {
    const economics = this.unitEconomics();
    const warnings: ReportsWarning[] = [];
    const toLineLabel = (line: MissingCostLine): string => {
      const id = [line.code, line.description].filter(Boolean).join(' - ').trim() || 'Unnamed line item';
      return `${line.invoiceNumber}: ${id}`;
    };
    if (economics.partUnknownCostLines > 0) {
      const details = economics.missingPartLines.slice(0, 5).map(toLineLabel);
      warnings.push({
        message: `Part costs missing on ${economics.partUnknownCostLines} sold line item(s). Add matching inventory SKU/name + cost to get complete part margin.`,
        details,
        moreCount: Math.max(0, economics.missingPartLines.length - details.length),
        actionLabel: 'Fix now',
        link: '/inventory'
      });
    }
    if (economics.laborUnknownCostLines > 0) {
      const details = economics.missingLaborLines.slice(0, 5).map(toLineLabel);
      warnings.push({
        message: `Labor costs missing on ${economics.laborUnknownCostLines} sold line item(s). Add labor rate costs in Admin -> Business Profile to complete labor margin.`,
        details,
        moreCount: Math.max(0, economics.missingLaborLines.length - details.length),
        actionLabel: 'Fix now',
        link: '/admin-settings',
        queryParams: { section: 'branding' }
      });
    }
    return warnings;
  });
  readonly localInvoiceSummary = computed(() => {
    const invoices = this.localInvoices();
    const quotes = this.localQuotes();
    const periodStart = this.parseAsDate(this.data()?.filters?.periodStart);
    const periodEnd = this.parseAsDate(this.data()?.filters?.periodEnd);

    let invoiceAmountInPeriod = 0;
    let invoiceCountInPeriod = 0;
    let quoteAmountInPeriod = 0;
    let quoteCountInPeriod = 0;
    let salesPast = 0;
    let paidAmountTotal = 0;

    for (const invoice of invoices) {
      const total = Math.max(0, Number(invoice.total || 0));
      const paid = Math.max(0, Number(invoice.paidAmount || 0));
      const effectiveDate = this.invoiceDate(invoice);
      if (effectiveDate && periodStart && effectiveDate.getTime() < periodStart.getTime()) {
        salesPast += total;
      }
      if (effectiveDate && periodStart && periodEnd && this.isDateInRange(effectiveDate, periodStart, periodEnd)) {
        invoiceAmountInPeriod += total;
        invoiceCountInPeriod += 1;
      }
      paidAmountTotal += paid;
    }

    for (const quote of quotes) {
      const total = Math.max(0, Number(quote.total || 0));
      const effectiveDate = this.invoiceDate(quote);
      if (effectiveDate && periodStart && periodEnd && this.isDateInRange(effectiveDate, periodStart, periodEnd)) {
        quoteAmountInPeriod += total;
        quoteCountInPeriod += 1;
      }
    }

    const openAmountTotal = Math.max(0, Number((invoices.reduce((sum, invoice) => sum + Math.max(0, Number(invoice.total || 0)), 0) - paidAmountTotal).toFixed(2)));

    return {
      invoices,
      quotes,
      invoiceAmountInPeriod: Number(invoiceAmountInPeriod.toFixed(2)),
      invoiceCountInPeriod,
      quoteAmountInPeriod: Number(quoteAmountInPeriod.toFixed(2)),
      quoteCountInPeriod,
      salesPast: Number(salesPast.toFixed(2)),
      paidAmountTotal: Number(paidAmountTotal.toFixed(2)),
      openAmountTotal
    };
  });
  readonly effectiveKpi = computed<ReportsKpiRow | null>(() => {
    const base = this.kpi();
    if (!base) return null;
    const local = this.localInvoiceSummary();
    const next = { ...base };
    if (next.invoice_amount <= 0 && local.invoiceAmountInPeriod > 0) {
      next.invoice_amount = local.invoiceAmountInPeriod;
    }
    if (next.invoices_created <= 0 && local.invoiceCountInPeriod > 0) {
      next.invoices_created = local.invoiceCountInPeriod;
    }
    if (next.quote_amount <= 0 && local.quoteAmountInPeriod > 0) {
      next.quote_amount = local.quoteAmountInPeriod;
    }
    if (next.quotes_created <= 0 && local.quoteCountInPeriod > 0) {
      next.quotes_created = local.quoteCountInPeriod;
    }
    if (next.sales_current_amount <= 0 && local.invoiceAmountInPeriod > 0) {
      next.sales_current_amount = local.invoiceAmountInPeriod;
    }
    if (next.sales_past_amount <= 0 && local.salesPast > 0) {
      next.sales_past_amount = local.salesPast;
    }
    next.average_invoice_amount = next.invoices_created > 0
      ? Number((next.invoice_amount / next.invoices_created).toFixed(2))
      : 0;
    next.average_quote_amount = next.quotes_created > 0
      ? Number((next.quote_amount / next.quotes_created).toFixed(2))
      : 0;
    return next;
  });
  readonly funnel = computed<ReportsFunnelRow[]>(() => this.data()?.tables?.funnel || []);
  readonly trend = computed<ReportsSalesTrendRow[]>(() => this.data()?.tables?.salesTrend || []);
  readonly aging = computed<ReportsInvoiceAgingRow[]>(() => this.data()?.tables?.invoiceAging || []);
  readonly leadSources = computed<ReportsLeadSourceRow[]>(() => this.data()?.tables?.leadSources || []);
  readonly communications = computed<ReportsCommunicationRow[]>(() => this.data()?.tables?.communicationVolume || []);
  readonly jobTiming = computed<ReportsJobTimingRow[]>(() => this.data()?.tables?.jobTiming || []);
  readonly jobTimingByWorkItemId = computed(() => {
    const map = new Map<string, ReportsJobTimingRow>();
    for (const row of this.jobTiming()) {
      const key = this.normalizeKey(row?.work_item_id);
      if (!key || map.has(key)) continue;
      map.set(key, row);
    }
    return map;
  });
  readonly productionForecast = computed<ReportsProductionForecastRow[]>(
    () => this.data()?.tables?.productionForecast || []
  );
  readonly cashflowForecast = computed<ReportsCashflowForecastRow[]>(
    () => this.data()?.tables?.cashflowForecast || []
  );
  readonly funnelMaxAmount = computed(() =>
    Math.max(1, ...this.funnel().map(row => Math.max(0, Number(row.amount || 0))))
  );
  readonly forecastWindowMonths = computed(() => {
    const months = Math.floor(Number(this.forecastMonths() || 0));
    return Math.max(1, Math.min(24, months || 6));
  });
  readonly nextCashflowRows = computed(() => this.cashflowForecast().slice(0, this.forecastWindowMonths()));
  readonly nextProductionRows = computed(() => this.productionForecast().slice(0, this.forecastWindowMonths()));
  readonly forecastHorizonLabel = computed(() => `${this.forecastWindowMonths()} month horizon`);
  readonly forecastCoverageCount = computed(() =>
    Math.max(this.nextCashflowRows().length, this.nextProductionRows().length)
  );
  readonly recentMarginRows = computed(() => this.trend().slice(-6));
  readonly projectedRevenueTotal = computed(() =>
    Number(this.nextProductionRows().reduce((sum, row) => sum + Number(row.projected_revenue || 0), 0).toFixed(2))
  );
  readonly projectedInflowTotal = computed(() =>
    Number(this.nextCashflowRows().reduce((sum, row) => sum + Number(row.projected_inflow || 0), 0).toFixed(2))
  );
  readonly projectedOutflowTotal = computed(() =>
    Number(this.nextCashflowRows().reduce((sum, row) => sum + Number(row.projected_outflow || 0), 0).toFixed(2))
  );
  readonly projectedGrossProfitTotal = computed(() =>
    Number(this.nextProductionRows().reduce((sum, row) => sum + Number(row.projected_gross_profit || 0), 0).toFixed(2))
  );
  readonly projectedLaborTotal = computed(() =>
    Number(this.nextProductionRows().reduce((sum, row) => sum + Number(row.projected_labor_cost || 0), 0).toFixed(2))
  );
  readonly projectedCashNet = computed(() =>
    Number(this.nextCashflowRows().reduce((sum, row) => sum + Number(row.net_cashflow || 0), 0).toFixed(2))
  );
  readonly projectedMarginPct = computed(() => {
    const revenue = this.projectedRevenueTotal();
    if (revenue <= 0) return 0;
    return Number(((this.projectedGrossProfitTotal() / revenue) * 100).toFixed(2));
  });
  readonly projectedRevenueMonthlyAvg = computed(() => {
    const months = this.forecastCoverageCount();
    if (months <= 0) return 0;
    return this.roundAmount(this.projectedRevenueTotal() / months);
  });
  readonly projectedCashMonthlyAvg = computed(() => {
    const months = this.forecastCoverageCount();
    if (months <= 0) return 0;
    return this.roundAmount(this.projectedCashNet() / months);
  });
  readonly forecastScheduleFillPct = computed(() => {
    const scheduled = this.forecastScheduledJobs();
    const pipeline = this.forecastPipelineJobs();
    const total = scheduled + pipeline;
    if (total <= 0) return 0;
    return this.roundAmount((scheduled / total) * 100);
  });
  readonly forecastLaborHoursVariance = computed(() =>
    this.roundAmount(this.forecastLaborHoursAdjusted() - this.forecastLaborHoursPlanned())
  );
  readonly usingLocalInvoiceFallback = computed(() => {
    const base = this.kpi();
    const local = this.localInvoiceSummary();
    if (!base) return false;
    return (
      (base.invoice_amount <= 0 && local.invoiceAmountInPeriod > 0)
      || (base.invoices_created <= 0 && local.invoiceCountInPeriod > 0)
      || (base.quote_amount <= 0 && local.quoteAmountInPeriod > 0)
      || (base.quotes_created <= 0 && local.quoteCountInPeriod > 0)
    );
  });
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
      'calendar-outline': calendarOutline,
      'cash-outline': cashOutline,
      'construct-outline': constructOutline,
      'information-circle-outline': informationCircleOutline,
      'stats-chart-outline': statsChartOutline,
      'trending-up-outline': trendingUpOutline,
      'pulse-outline': pulseOutline,
      'refresh-outline': refreshOutline
    });
  }

  ngOnInit(): void {
    this.refresh();
    this.loadEconomicsSources();
    if (this.powerBiEnabled) {
      this.loadPowerBiConfig();
    }
  }

  ngAfterViewInit(): void {
    this.viewInitialized = true;
    this.renderPowerBiSecureEmbed();
  }

  ngOnDestroy(): void {
    this.resetPowerBiEmbed();
  }

  refresh(): void {
    const from = this.normalizeDateInput(this.periodStart());
    const to = this.normalizeDateInput(this.periodEnd());
    if (from && to && Date.parse(from) > Date.parse(to)) {
      this.error.set('Start date must be on or before end date.');
      return;
    }
    this.loading.set(true);
    this.error.set('');
    this.reportsApi.getPowerBiDataset({
      from: from || undefined,
      to: to || undefined,
      monthsBack: 12,
      futureDays: 90,
      forecastMonths: Number(this.forecastMonths() || 3),
      openingCash: this.openingCash()
    }).subscribe({
      next: res => {
        this.data.set(res);
        if (!from) this.periodStart.set(this.normalizeDateInput(res?.filters?.periodStart));
        if (!to) this.periodEnd.set(this.normalizeDateInput(res?.filters?.periodEnd));
        this.trendPage.set(1);
        this.productionForecastPage.set(1);
        this.cashflowForecastPage.set(1);
        this.loadEconomicsSources();
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
    if (!this.powerBiEnabled) {
      this.powerBi.set(null);
      this.powerBiWebUrl.set(null);
      this.powerBiLoading.set(false);
      this.resetPowerBiEmbed();
      return;
    }
    this.powerBiLoading.set(true);
    this.reportsApi.getPowerBiConfig(false).subscribe({
      next: res => {
        const powerBi = res.powerBi || null;
        this.powerBi.set(powerBi);
        this.powerBiWebUrl.set(this.buildPowerBiWebUrl(powerBi));
        this.powerBiLoading.set(false);
        if (powerBi?.secureEmbedReady) {
          this.loadPowerBiEmbedConfig();
          return;
        }
        if (powerBi?.webEmbedReady) {
          this.resetPowerBiEmbed();
          return;
        }
        this.resetPowerBiEmbed();
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
        const fallbackWebUrl = this.buildPowerBiWebUrl(this.powerBi());
        this.powerBiWebUrl.set(fallbackWebUrl);
        this.resetPowerBiEmbed();
        if (!fallbackWebUrl) {
          this.error.set(this.extractError(err, 'Could not load Power BI embed configuration.'));
        }
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
    const guidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isGuid = (value: string): boolean => guidPattern.test(String(value || '').trim());
    const isWorkspaceRef = (value: string): boolean => isGuid(value) || String(value || '').trim().toLowerCase() === 'me';

    // Prefer explicit report URL when present; IDs can be stale.
    if (reportWebUrl) {
      try {
        const parsed = new URL(reportWebUrl);
        const host = String(parsed.hostname || '').toLowerCase();
        if (host.endsWith('powerbi.com')) {
          if (parsed.pathname.toLowerCase().includes('/reportembed')) {
            const qReportId = String(parsed.searchParams.get('reportId') || '').trim();
            const qGroupId = String(parsed.searchParams.get('groupId') || '').trim();
            if (isGuid(qReportId) && (!qGroupId || isWorkspaceRef(qGroupId))) {
              if (!parsed.searchParams.has('navContentPaneEnabled')) {
                parsed.searchParams.set('navContentPaneEnabled', 'false');
              }
              return parsed.toString();
            }
          }

          const parts = parsed.pathname.split('/').filter(Boolean);
          const groupsIndex = parts.findIndex(segment => segment.toLowerCase() === 'groups');
          const reportsIndex = parts.findIndex(segment => segment.toLowerCase() === 'reports');
          const groupId = groupsIndex >= 0 ? String(parts[groupsIndex + 1] || '').trim() : '';
          const inferredReportId = reportsIndex >= 0 ? String(parts[reportsIndex + 1] || '').trim() : '';
          if (isWorkspaceRef(groupId) && isGuid(inferredReportId)) {
            const embed = new URL('/reportEmbed', `${parsed.protocol}//${parsed.host}`);
            embed.searchParams.set('groupId', groupId);
            embed.searchParams.set('reportId', inferredReportId);
            embed.searchParams.set('autoAuth', 'true');
            if (tenantId) embed.searchParams.set('ctid', tenantId);
            embed.searchParams.set('navContentPaneEnabled', 'false');
            return embed.toString();
          }
        }
      } catch {
        // Ignore malformed URL and fall back to explicit IDs below.
      }
    }

    if (isWorkspaceRef(workspaceId) && isGuid(reportId)) {
      const url = new URL('/reportEmbed', fallbackHost);
      url.searchParams.set('groupId', workspaceId);
      url.searchParams.set('reportId', reportId);
      url.searchParams.set('autoAuth', 'true');
      if (tenantId) url.searchParams.set('ctid', tenantId);
      url.searchParams.set('navContentPaneEnabled', 'false');
      return url.toString();
    }

    return '';
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

  applyDateRange(): void {
    this.refresh();
  }

  clearDateRange(): void {
    this.periodStart.set('');
    this.periodEnd.set('');
    this.refresh();
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

  private loadEconomicsSources(): void {
    this.inventoryApi.listItems().subscribe({
      next: response => {
        this.inventoryItems.set(Array.isArray(response?.items) ? response.items : []);
      },
      error: () => {
        this.inventoryItems.set([]);
      }
    });
    this.workItemsApi.list().subscribe({
      next: items => {
        this.workItems.set(Array.isArray(items) ? items : []);
      },
      error: () => {
        this.workItems.set([]);
      }
    });
    this.settingsApi.getValue<LaborRateSetting[]>(BUSINESS_LABOR_RATES_SETTING_KEY).subscribe({
      next: value => {
        const rows = Array.isArray(value) ? value : [];
        this.laborRates.set(
          rows
            .map((item, index) => ({
              id: String(item?.id || '').trim() || `labor-${index}`,
              name: String(item?.name || '').trim(),
              price: this.roundAmount(Math.max(0, Number(item?.price || 0))),
              taxable: !!item?.taxable,
              cost: this.roundAmount(Math.max(0, Number(item?.cost || 0)))
            }))
            .filter(item => !!item.name)
        );
      },
      error: () => {
        this.laborRates.set([]);
      }
    });
    this.settingsApi.getValue<ScheduleSettings>(SCHEDULE_SETTINGS_KEY).subscribe({
      next: value => {
        this.scheduleSettings.set(this.normalizeScheduleSettings(value));
      },
      error: () => {
        this.scheduleSettings.set({ ...DEFAULT_SCHEDULE_SETTINGS });
      }
    });
  }

  private matchWorkItemForInvoice(invoice: InvoiceDetail, soldDate: Date | null): WorkItem | null {
    const allItems = this.workItems();
    if (!allItems.length) return null;

    const customerId = this.normalizeKey(invoice.customerId);
    const customerName = this.normalizeKey(invoice.customerName);

    let candidates = allItems.filter(item => this.normalizeKey(item.customerId) === customerId);
    if (!candidates.length && customerName) {
      candidates = allItems.filter(item => this.normalizeKey(item.title).includes(customerName));
    }
    if (!candidates.length) return null;

    const soldAtMs = soldDate?.getTime() || 0;
    const ranked = candidates
      .map(item => {
        const completedMs = this.parseAsDate(item.completedAt || null)?.getTime() || 0;
        const updatedMs = this.parseAsDate(item.updatedAt || null)?.getTime() || 0;
        const createdMs = this.parseAsDate(item.createdAt || null)?.getTime() || 0;
        const anchorMs = completedMs || updatedMs || createdMs;
        const diffFromSold = soldAtMs > 0 && anchorMs > 0 ? Math.abs(anchorMs - soldAtMs) : Number.MAX_SAFE_INTEGER;
        return {
          item,
          hasDuration: Number(item.workDurationMs || 0) > 0,
          hasCheckIn: !!String(item.checkedInAt || '').trim(),
          hasCompleted: !!String(item.completedAt || '').trim(),
          diffFromSold,
          anchorMs
        };
      })
      .sort((a, b) =>
        Number(b.hasDuration) - Number(a.hasDuration)
        || Number(b.hasCheckIn) - Number(a.hasCheckIn)
        || Number(b.hasCompleted) - Number(a.hasCompleted)
        || a.diffFromSold - b.diffFromSold
        || b.anchorMs - a.anchorMs
      );
    return ranked[0]?.item || null;
  }

  private computeActualWorkedHours(item: WorkItem | null): number {
    if (!item) return 0;
    const serverRow = this.jobTimingByWorkItemId().get(this.normalizeKey(item.id));
    const serverHours = Math.max(0, Number(serverRow?.tracked_hours_business || 0));
    if (serverHours > 0) return serverHours;

    const baseMs = Math.max(0, Number(item.workDurationMs || 0));
    const checkedInAt = this.parseAsDate(item.checkedInAt || null);
    const completedAt = this.parseAsDate(item.completedAt || null);
    const pausedAt = this.parseAsDate(item.pausedAt || null);
    const isPaused = !!item.isPaused || !!String(item.pausedAt || '').trim();
    const now = new Date();

    const resumedAt = this.parseAsDate(item.lastWorkResumedAt || item.checkedInAt || null);
    const inFlightMs = (!completedAt && !isPaused && resumedAt)
      ? this.businessWindowElapsedMs(resumedAt, now)
      : 0;
    const rawTimingMs = baseMs + inFlightMs;

    const spanEnd = completedAt || pausedAt || now;
    const businessWindowSpanMs = checkedInAt
      ? this.businessWindowElapsedMs(checkedInAt, spanEnd)
      : 0;

    const effectiveMs = rawTimingMs > 0 && businessWindowSpanMs > 0
      ? Math.min(rawTimingMs, businessWindowSpanMs)
      : Math.max(rawTimingMs, businessWindowSpanMs);

    return effectiveMs / ReportsComponent.MS_PER_HOUR;
  }

  stageAmountWidth(amount: number): string {
    const max = this.funnelMaxAmount();
    const safeAmount = Math.max(0, Number(amount || 0));
    const widthPct = Math.max(8, Math.min(100, (safeAmount / max) * 100));
    return `${widthPct.toFixed(1)}%`;
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

  private parseAsDate(value: string | undefined | null): Date | null {
    const text = String(value || '').trim();
    if (!text) return null;
    const parsed = Date.parse(text);
    if (!Number.isFinite(parsed)) return null;
    return new Date(parsed);
  }

  private normalizeDateInput(value: string | undefined | null): string {
    const parsed = this.parseAsDate(value);
    return parsed ? parsed.toISOString().slice(0, 10) : '';
  }

  private normalizeScheduleSettings(value: unknown): ScheduleSettings {
    const parsed = value && typeof value === 'object' ? (value as Partial<ScheduleSettings>) : {};
    const fallback = DEFAULT_SCHEDULE_SETTINGS;
    const openHourRaw = Number(parsed.openHour);
    const closeHourRaw = Number(parsed.closeHour);

    const openHour = Number.isFinite(openHourRaw)
      ? Math.min(23, Math.max(0, Math.floor(openHourRaw)))
      : fallback.openHour;
    let closeHour = Number.isFinite(closeHourRaw)
      ? Math.min(24, Math.max(1, Math.floor(closeHourRaw)))
      : fallback.closeHour;
    if (closeHour <= openHour) closeHour = Math.min(24, openHour + 1);

    return {
      openHour,
      closeHour,
      showWeekends: typeof parsed.showWeekends === 'boolean' ? parsed.showWeekends : fallback.showWeekends
    };
  }

  private businessWindowElapsedMs(start: Date | null, end: Date | null): number {
    if (!start || !end) return 0;
    const startMs = start.getTime();
    const endMs = end.getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;

    const settings = this.scheduleSettings();
    const openHour = Math.min(23, Math.max(0, Number(settings.openHour ?? DEFAULT_SCHEDULE_SETTINGS.openHour)));
    let closeHour = Math.min(24, Math.max(1, Number(settings.closeHour ?? DEFAULT_SCHEDULE_SETTINGS.closeHour)));
    if (closeHour <= openHour) closeHour = Math.min(24, openHour + 1);
    const includeWeekends = !!settings.showWeekends;

    let totalMs = 0;
    let cursor = new Date(startMs);
    cursor.setHours(0, 0, 0, 0);
    let dayCount = 0;
    const maxDays = 3660;

    while (cursor.getTime() < endMs && dayCount < maxDays) {
      const day = cursor.getDay();
      const isWeekend = day === 0 || day === 6;
      if (includeWeekends || !isWeekend) {
        const dayStart = new Date(cursor.getTime());
        dayStart.setHours(openHour, 0, 0, 0);
        const dayEnd = new Date(cursor.getTime());
        dayEnd.setHours(closeHour, 0, 0, 0);

        const overlapStart = Math.max(startMs, dayStart.getTime());
        const overlapEnd = Math.min(endMs, dayEnd.getTime());
        if (overlapEnd > overlapStart) totalMs += overlapEnd - overlapStart;
      }
      cursor.setDate(cursor.getDate() + 1);
      dayCount += 1;
    }

    return totalMs;
  }

  private invoiceDate(invoice: { issueDate?: string; createdAt?: string }): Date | null {
    const issue = this.parseAsDate(invoice.issueDate || null);
    if (issue) return issue;
    return this.parseAsDate(invoice.createdAt || null);
  }

  private isDateInRange(date: Date, start: Date, end: Date): boolean {
    const t = date.getTime();
    return t >= start.getTime() && t <= end.getTime();
  }

  private isSoldInvoice(invoice: {
    stage?: string;
    paidAmount?: number;
    paymentTransactions?: Array<{ amount?: number }>;
  }): boolean {
    const stage = String(invoice.stage || '').toLowerCase();
    const paidAmount = Math.max(0, Number(invoice.paidAmount || 0));
    const transactionPaidAmount = Array.isArray(invoice.paymentTransactions)
      ? invoice.paymentTransactions.reduce((sum, row) => sum + Math.max(0, Number(row?.amount || 0)), 0)
      : 0;
    return (
      stage === 'accepted'
      || stage === 'completed'
      || stage === 'paid'
      || paidAmount > 0
      || transactionPaidAmount > 0
    );
  }

  private resolvePartUnitCost(code: string | undefined, description: string | undefined): number {
    const codeKey = this.normalizeKey(code);
    const descKey = this.normalizeKey(description);
    const item =
      (codeKey ? this.inventorySkuMap().get(codeKey) : undefined)
      || (descKey ? this.inventoryNameMap().get(descKey) : undefined);
    if (!item) return 0;
    const explicitCost = Math.max(0, Number(item.cost || 0));
    if (explicitCost > 0) return this.roundAmount(explicitCost);
    const unitCost = Math.max(0, Number(item.unitCost || 0));
    return this.roundAmount(unitCost);
  }

  private resolveLaborUnitCost(code: string | undefined, description: string | undefined): number {
    const codeKey = this.normalizeKey(code);
    const descKey = this.normalizeKey(description);
    const rate =
      (codeKey ? this.laborRateIdMap().get(codeKey) : undefined)
      || (descKey ? this.laborRateNameMap().get(descKey) : undefined);
    if (!rate) return 0;
    return this.roundAmount(Math.max(0, Number(rate.cost || 0)));
  }

  private normalizeKey(value: unknown): string {
    return String(value || '').trim().toLowerCase();
  }

  private roundAmount(value: number): number {
    return Number((Number(value || 0)).toFixed(2));
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

  trackJobProfitRow(_index: number, row: JobProfitMatrixRow): string {
    return row.key;
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
