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

export type ReportsTables = {
  kpiSummary: ReportsKpiRow[];
  funnel: ReportsFunnelRow[];
  salesTrend: ReportsSalesTrendRow[];
  invoiceAging: ReportsInvoiceAgingRow[];
  leadSources: ReportsLeadSourceRow[];
  communicationVolume: ReportsCommunicationRow[];
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
  };
  tables: ReportsTables;
};

export type ReportsQuery = {
  from?: string;
  to?: string;
  monthsBack?: number;
  futureDays?: number;
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
    return this.http.get<ReportsResponse>('/api/reports/powerbi', { params });
  }
}
