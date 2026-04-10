import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export type PaymentRefundPayload = {
  invoiceId: string;
  tenantId: string;
  provider: string;
  amount: string;
  invoiceNumber?: string;
  originalTransactionId: string;
  accountNumber?: string;
  reason?: string;
};

export type PaymentRefundResponse = {
  ok: boolean;
  provider: string;
  mode?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  amount?: string;
  originalTransactionId?: string;
  refundTransactionId?: string;
  authCode?: string;
  avsResultCode?: string;
  accountType?: string;
  accountNumber?: string;
};

@Injectable({ providedIn: 'root' })
export class PaymentRefundApiService {
  private readonly http = inject(HttpClient);

  refund(payload: PaymentRefundPayload): Observable<PaymentRefundResponse> {
    return this.http.post<PaymentRefundResponse>('/api/payment-refund', payload, {
      headers: new HttpHeaders({ 'x-skip-action-toast': '1' })
    });
  }
}
