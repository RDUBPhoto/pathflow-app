import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { TenantContextService } from './tenant-context.service';
import { InvoiceLineItem } from './invoices-data.service';

export type InvoiceResponseAction = 'pay';
export type InvoiceResponseStage = 'accepted' | 'sent';

export type InvoiceResponsePayload = {
  invoiceId: string;
  action: InvoiceResponseAction;
  tenantId: string;
  invoiceNumber?: string;
  jobNumber?: string;
  customerId?: string;
  customerName?: string;
  vehicle?: string;
  businessName?: string;
  paymentKind?: 'initial' | 'final';
  paymentAmount?: number;
  paymentProvider?: string;
  paymentTransactionId?: string;
  paymentAccountNumber?: string;
  lineItems?: InvoiceLineItem[];
};

export type InvoiceSnapshotPayload = {
  invoiceId: string;
  publicToken: string;
  keepExistingToken?: boolean;
  tenantId: string;
  invoiceNumber?: string;
  customerName?: string;
  customerEmail?: string;
  vehicle?: string;
  businessName?: string;
  amount?: string;
  dueDate?: string;
  paymentUrl?: string;
  paymentProvider?: string;
  invoiceData: unknown;
};

export type InvoiceResponseRecord = {
  invoiceId: string;
  action: InvoiceResponseAction | 'void' | 'refund';
  stage: InvoiceResponseStage;
  invoiceNumber: string;
  updatedAt: string;
  paymentAmount?: number;
  paidAmount?: number;
  paymentKind?: string;
  jobId?: string;
  paymentProvider?: string;
  paymentTransactionId?: string;
  paymentAccountNumber?: string;
};

export type InvoiceResponseListResponse = {
  ok: boolean;
  tenantId: string;
  items: InvoiceResponseRecord[];
};

@Injectable({ providedIn: 'root' })
export class InvoiceResponseApiService {
  private readonly auth = inject(AuthService);
  private readonly tenantContext = inject(TenantContextService);

  constructor(private readonly http: HttpClient) {}

  recordManualPayment(payload: InvoiceResponsePayload): Observable<{ ok: boolean; stage: InvoiceResponseStage }> {
    return this.http.post<{ ok: boolean; stage: InvoiceResponseStage }>(
      '/api/invoice-response',
      { ...payload, op: 'record-manual-payment' },
      { headers: new HttpHeaders({ 'x-skip-action-toast': '1', 'x-tenant-id': payload.tenantId }) }
    );
  }

  publishSnapshot(payload: InvoiceSnapshotPayload): Observable<{ ok: boolean; invoiceId: string; publicToken: string }> {
    return this.http.post<{ ok: boolean; invoiceId: string; publicToken: string }>(
      '/api/invoice-response',
      { op: 'publish-snapshot', ...payload },
      { headers: new HttpHeaders({ 'x-skip-action-toast': '1', 'x-tenant-id': payload.tenantId }) }
    );
  }

  getSnapshot(invoiceId: string, publicToken: string, tenantId: string): Observable<{ ok: boolean; tenantId: string; item: unknown | null }> {
    const params = new URLSearchParams();
    const headers = { 'x-skip-action-toast': '1', 'x-tenant-id': tenantId };
    params.set('invoiceId', invoiceId);
    if (!publicToken.startsWith('vp_')) params.set('publicToken', publicToken);
    params.set('tenantId', tenantId);
    return this.http.get<{ ok: boolean; tenantId: string; item: unknown | null }>(
      `/api/invoice-response?${params.toString()}`,
      { headers: new HttpHeaders(publicToken.startsWith('vp_') ? { ...headers, 'x-visit-token': publicToken } : headers) }
    );
  }

  listRecent(limit = 250): Observable<InvoiceResponseListResponse> {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 250;
    const query = this.buildQuery();
    const url = `/api/invoice-response?limit=${safeLimit}${query ? `&${query}` : ''}`;
    return this.http.get<InvoiceResponseListResponse>(url, {
      headers: new HttpHeaders({ 'x-skip-action-toast': '1' })
    });
  }

  private buildQuery(): string {
    const tenantId = String(this.tenantContext.tenantId() || '').trim().toLowerCase() || 'primary-location';
    const user = this.auth.user();
    const params = new URLSearchParams();
    if (tenantId) params.set('tenantId', tenantId);
    if (user?.id) params.set('userId', user.id);
    if (user?.email) params.set('userEmail', user.email);
    if (user?.displayName) params.set('userName', user.displayName);
    return params.toString();
  }
}
