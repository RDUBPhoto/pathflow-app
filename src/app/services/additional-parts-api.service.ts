import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type AdditionalPartApprovalStatus = 'pending' | 'approved' | 'declined' | 'not_required';
export type AdditionalPartBillingStatus =
  | 'not_added'
  | 'quote_update_needed'
  | 'invoice_update_needed'
  | 'payment_needed'
  | 'added_to_invoice'
  | 'paid';
export type AdditionalPartInvoiceReviewStatus = 'needs_review' | 'reviewed';
export type AdditionalPartStatus = 'requested' | 'ordered' | 'received' | 'installed' | 'cancelled';

export type AdditionalPart = {
  id: string;
  jobId?: string;
  jobNumber?: string;
  relatedScheduleId?: string;
  relatedWorkItemId?: string;
  relatedQuoteId?: string;
  relatedInvoiceId?: string;
  relatedInventoryItemId?: string;
  vendorId?: string;
  vendor?: string;
  partName: string;
  sku?: string;
  description?: string;
  quantity: number;
  cost: number;
  markup: number;
  customerPrice: number;
  reasonNotes?: string;
  addedBy?: string;
  addedById?: string;
  addedAt?: string;
  approvalStatus: AdditionalPartApprovalStatus;
  approvedAt?: string;
  approvedBy?: string;
  approvedById?: string;
  billingStatus: AdditionalPartBillingStatus;
  invoiceReviewStatus: AdditionalPartInvoiceReviewStatus;
  reviewedBy?: string;
  reviewedById?: string;
  reviewedAt?: string;
  status: AdditionalPartStatus;
  createdAt?: string;
  updatedAt?: string;
};

export type AdditionalPartPayload = Partial<AdditionalPart> & {
  partName?: string;
  sku?: string;
};

export type AdditionalPartQuery = {
  jobId?: string;
  jobNumber?: string;
  scheduleId?: string;
  workItemId?: string;
  invoiceId?: string;
};

@Injectable({ providedIn: 'root' })
export class AdditionalPartsApiService {
  constructor(private readonly http: HttpClient) {}

  list(query: AdditionalPartQuery = {}): Observable<{ ok: boolean; parts: AdditionalPart[] }> {
    const params = new URLSearchParams();
    if (query.jobId) params.set('jobId', query.jobId);
    if (query.jobNumber) params.set('jobNumber', query.jobNumber);
    if (query.scheduleId) params.set('scheduleId', query.scheduleId);
    if (query.workItemId) params.set('workItemId', query.workItemId);
    if (query.invoiceId) params.set('invoiceId', query.invoiceId);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.http.get<{ ok: boolean; parts: AdditionalPart[] }>(`/api/additional-parts${suffix}`);
  }

  create(payload: AdditionalPartPayload): Observable<{ ok: boolean; part: AdditionalPart }> {
    return this.http.post<{ ok: boolean; part: AdditionalPart }>('/api/additional-parts', {
      op: 'create',
      ...payload
    });
  }

  update(id: string, payload: AdditionalPartPayload): Observable<{ ok: boolean; part: AdditionalPart }> {
    return this.http.post<{ ok: boolean; part: AdditionalPart }>('/api/additional-parts', {
      op: 'update',
      id,
      ...payload
    });
  }
}
