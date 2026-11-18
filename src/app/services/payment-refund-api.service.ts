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
  alreadyReversed?: number;
  accountNumber?: string;
  reason?: string;
  expectedOperation?: 'void' | 'refund';
  creditInvoice?: boolean;
  retainedFee?: number;
};

export type PaymentRefundPreview = {
  operation: 'void' | 'refund';
  originalAmount: number;
  alreadyReversed: number;
  refundableAmount: number;
  invoiceTotal: number;
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
  operation?: 'void' | 'refund';
  paidAmount?: number;
  returnCreditAmount?: number;
  reversal?: { id: string; createdAt: string; recordedBy?: string };
};

@Injectable({ providedIn: 'root' })
export class PaymentRefundApiService {
  private readonly http = inject(HttpClient);

  preview(invoiceId: string, tenantId: string, originalTransactionId: string): Observable<PaymentRefundPreview> {
    return this.http.get<PaymentRefundPreview>('/api/payment-refund', {
      params: { invoiceId, provider: 'paylynx', originalTransactionId },
      headers: { 'x-tenant-id': tenantId, 'x-skip-action-toast': '1' }
    });
  }

  refund(payload: PaymentRefundPayload): Observable<PaymentRefundResponse> {
    return this.http.post<PaymentRefundResponse>('/api/payment-refund', payload, {
      headers: new HttpHeaders({ 'x-skip-action-toast': '1' })
    });
  }
}
