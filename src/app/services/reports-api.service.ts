import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

export type ReportsKpiRow = {
  report_generated_at: string;
  period_start: string;
  period_end: string;
  total_customers: number;
  leads_created: number;
  quotes_created: number;
  invoices_created: number;
  quote_amount: number;
  invoice_amount: number;
  average_quote_amount: number;
  average_invoice_amount: number;
  sales_past_amount: number;
  sales_current_amount: number;
  sales_future_amount: number;
  active_leads: number;
  active_quotes: number;
  active_scheduled: number;
  active_in_progress: number;
  active_completed: number;
  active_invoiced: number;
  upcoming_scheduled_jobs: number;
  lead_to_quote_rate_pct: number;
  quote_to_invoice_rate_pct: number;
};

export type ReportsFunnelRow = {
  stage_order: number;
  stage_key: string;
  stage_label: string;
  item_count: number;
  amount: number;
  conversion_from_previous_pct: number | null;
};

export type ReportsSalesTrendRow = {
  period_key: string;
  period_start: string;
  period_end: string;
  leads_count: number;
  quote_count: number;
  quote_amount: number;
  invoice_count: number;
  sales_amount: number;
  cogs_amount: number;
  gross_profit: number;
  gross_margin_pct: number;
};

export type ReportsInvoiceAgingRow = {
  bucket_key: string;
  bucket_label: string;
  min_days: number;
  max_days: number | null;
  invoice_count: number;
  outstanding_amount: number;
};

export type ReportsLeadSourceRow = {
  source_key: string;
  lead_count: number;
  pipeline_amount: number;
};

export type ReportsCommunicationRow = {
  channel: string;
  direction: 'inbound' | 'outbound';
  message_count: number;
};

export type ReportsProductionForecastRow = {
  period_key: string;
  period_start: string;
  period_end: string;
  scheduled_jobs: number;
  pipeline_items: number;
  scheduled_revenue: number;
  pipeline_weighted_revenue: number;
  projected_revenue: number;
  committed_po_spend: number;
  pending_need_spend: number;
  projected_parts_cogs: number;
  projected_labor_cost: number;
  projected_gross_profit: number;
  projected_gross_margin_pct: number;
};

export type ReportsCashflowForecastRow = {
  period_key: string;
  period_start: string;
  period_end: string;
  opening_cash: number;
  invoice_collections_due: number;
  forecast_collections: number;
  projected_inflow: number;
  projected_outflow: number;
  net_cashflow: number;
  ending_cash: number;
};

export type ReportsTables = {
  kpiSummary: ReportsKpiRow[];
  funnel: ReportsFunnelRow[];
  salesTrend: ReportsSalesTrendRow[];
  invoiceAging: ReportsInvoiceAgingRow[];
  leadSources: ReportsLeadSourceRow[];
  communicationVolume: ReportsCommunicationRow[];
  productionForecast: ReportsProductionForecastRow[];
  cashflowForecast: ReportsCashflowForecastRow[];
};

export type ReportsResponse = {
  ok: boolean;
  scope: string;
  generatedAt: string;
  filters: {
    periodStart: string;
    periodEnd: string;
    monthsBack: number;
    futureDays: number;
    forecastMonths: number;
    openingCash?: number;
  };
  tables: ReportsTables;
};

export type PowerBiConfigResponse = {
  ok: boolean;
  scope: string;
  powerBi: {
    mode: 'unconfigured' | 'web' | 'secure-embed';
    configured: boolean;
    secureEmbedReady: boolean;
    webEmbedReady: boolean;
    missingSecureKeys: string[];
    reportWebUrl: string | null;
    reportId?: string | null;
    reportName?: string | null;
    embedUrl?: string | null;
    embedToken?: string | null;
    embedTokenId?: string | null;
    embedTokenExpiration?: string | null;
    workspaceId?: string | null;
    tenantId?: string | null;
    error?: string | null;
  };
};

export type ReportsQuery = {
  from?: string;
  to?: string;
  monthsBack?: number;
  futureDays?: number;
  forecastMonths?: number;
  openingCash?: number;
};

export type ReportsSeedDemoResponse = {
  ok: boolean;
  scope: string;
  message: string;
  workItemsSeeded: number;
  invoicesSeeded: number;
};

@Injectable({ providedIn: 'root' })
export class ReportsApiService {
  constructor(private readonly http: HttpClient) {}

  getPowerBiDataset(query: ReportsQuery = {}): Observable<ReportsResponse> {
    let params = new HttpParams();
    if (query.from) params = params.set('from', query.from);
    if (query.to) params = params.set('to', query.to);
    if (query.monthsBack != null) params = params.set('monthsBack', String(query.monthsBack));
    if (query.futureDays != null) params = params.set('futureDays', String(query.futureDays));
    if (query.forecastMonths != null) params = params.set('forecastMonths', String(query.forecastMonths));
    if (query.openingCash != null) params = params.set('openingCash', String(query.openingCash));
    return this.http.get<ReportsResponse>('/api/reports/powerbi', { params });
  }

  getPowerBiConfig(includeToken = false): Observable<PowerBiConfigResponse> {
    const params = includeToken ? new HttpParams().set('includeToken', 'true') : undefined;
    return this.http.get<PowerBiConfigResponse>('/api/reports/powerbi-config', { params });
  }

  getPowerBiEmbedConfig(includeToken = true): Observable<PowerBiConfigResponse> {
    const params = includeToken ? new HttpParams().set('includeToken', 'true') : undefined;
    return this.http.get<PowerBiConfigResponse>('/api/reports/powerbi-embed', { params });
  }

  seedDemoData(): Observable<ReportsSeedDemoResponse> {
    return this.http.post<ReportsSeedDemoResponse>('/api/reports/seed-demo', {});
  }
}
