import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { TenantContextService } from './tenant-context.service';

export type InvoiceResponseAction = 'pay';
export type InvoiceResponseStage = 'accepted';

export type InvoiceResponsePayload = {
  invoiceId: string;
  action: InvoiceResponseAction;
  tenantId: string;
  invoiceNumber?: string;
  customerName?: string;
  vehicle?: string;
  businessName?: string;
  paymentKind?: 'initial' | 'final';
};

export type InvoiceResponseRecord = {
  invoiceId: string;
  action: InvoiceResponseAction;
  stage: InvoiceResponseStage;
  invoiceNumber: string;
  updatedAt: string;
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

  capture(payload: InvoiceResponsePayload): Observable<{ ok: boolean; stage: InvoiceResponseStage }> {
    return this.http.post<{ ok: boolean; stage: InvoiceResponseStage }>(
      '/api/invoice-response',
      payload,
      { headers: new HttpHeaders({ 'x-skip-action-toast': '1' }) }
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
