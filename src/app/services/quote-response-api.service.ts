import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { AuthService } from '../auth/auth.service';

export type QuoteResponseAction = 'accept' | 'decline';
export type QuoteResponseStage = 'accepted' | 'declined';

export type QuoteResponsePayload = {
  quoteId: string;
  action: QuoteResponseAction;
  tenantId: string;
  quoteNumber?: string;
  customerName?: string;
  vehicle?: string;
  businessName?: string;
};

export type QuoteResponseRecord = {
  quoteId: string;
  action: QuoteResponseAction;
  stage: QuoteResponseStage;
  quoteNumber: string;
  updatedAt: string;
};

export type QuoteResponseListResponse = {
  ok: boolean;
  tenantId: string;
  items: QuoteResponseRecord[];
};

@Injectable({ providedIn: 'root' })
export class QuoteResponseApiService {
  private readonly auth = inject(AuthService);

  constructor(private readonly http: HttpClient) {}

  capture(payload: QuoteResponsePayload): Observable<{ ok: boolean; stage: QuoteResponseStage }> {
    return this.http.post<{ ok: boolean; stage: QuoteResponseStage }>(
      '/api/quote-response',
      payload,
      { headers: new HttpHeaders({ 'x-skip-action-toast': '1' }) }
    );
  }

  listRecent(limit = 250): Observable<QuoteResponseListResponse> {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 250;
    const query = this.buildActorQuery();
    const url = `/api/quote-response?limit=${safeLimit}${query ? `&${query}` : ''}`;
    return this.http.get<QuoteResponseListResponse>(url, {
      headers: new HttpHeaders({ 'x-skip-action-toast': '1' })
    });
  }

  private buildActorQuery(): string {
    const user = this.auth.user();
    const params = new URLSearchParams();
    if (user?.id) params.set('userId', user.id);
    if (user?.email) params.set('userEmail', user.email);
    if (user?.displayName) params.set('userName', user.displayName);
    return params.toString();
  }
}
