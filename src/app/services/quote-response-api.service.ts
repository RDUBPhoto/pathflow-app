import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

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
    return this.http.get<QuoteResponseListResponse>(`/api/quote-response?limit=${safeLimit}`, {
      headers: new HttpHeaders({ 'x-skip-action-toast': '1' })
    });
  }
}
