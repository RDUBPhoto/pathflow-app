import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type PurchaseOrderStatus = 'draft' | 'ordered' | 'received' | 'cancelled';

export type PurchaseOrderLine = {
  lineId?: string;
  needId?: string;
  itemId?: string;
  relatedInventoryItemId?: string;
  relatedInvoiceId?: string;
  relatedInvoiceLineItemId?: string;
  jobId?: string;
  jobNumber?: string;
  partName: string;
  sku?: string;
  vendorId?: string;
  vendor?: string;
  qty: number;
  qtyNeeded?: number;
  qtyOrdered?: number;
  qtyReceived?: number;
  unitCost?: number;
  orderNumber?: string;
  trackingNumber?: string;
  carrier?: string;
  trackingStatus?: string;
  trackingStatusUpdatedAt?: string;
  estimatedDeliveryDate?: string;
  deliveredAt?: string;
  trackingProvider?: string;
  trackingProviderId?: string;
  trackingLastError?: string;
  etaDate?: string;
  vendorInvoiceNumber?: string;
  note?: string;
  lineTotal?: number;
  status?: 'draft' | 'ordered' | 'partial' | 'received' | 'cancelled';
};

export type PurchaseOrder = {
  id: string;
  supplier: string;
  vendorId?: string;
  status: PurchaseOrderStatus;
  currency: string;
  note: string;
  lines: PurchaseOrderLine[];
  lineCount: number;
  subtotal: number;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  receivedAt: string | null;
};

export type PurchaseOrderPayload = {
  supplier?: string;
  vendorId?: string;
  note?: string;
  currency?: string;
  lines?: PurchaseOrderLine[];
  needIds?: string[];
};

export type PurchaseOrderReceiptLine = {
  lineId: string;
  qtyReceived: number;
  orderNumber?: string;
  trackingNumber?: string;
  carrier?: string;
  etaDate?: string;
  vendorInvoiceNumber?: string;
  note?: string;
};

export type PurchaseOrderTrackingLine = {
  lineId: string;
  orderNumber?: string;
  trackingNumber?: string;
  carrier?: string;
  etaDate?: string;
  vendorInvoiceNumber?: string;
  note?: string;
};

export type PurchaseOrderTrackingRefreshLine = {
  lineId: string;
  trackingNumber?: string;
  carrier?: string;
};

export type PurchaseOrderTrackingRefreshResult = {
  lineId: string;
  ok: boolean;
  trackingStatus?: string;
  etaDate?: string;
  error?: string;
};

@Injectable({ providedIn: 'root' })
export class PurchaseOrdersApiService {
  constructor(private readonly http: HttpClient) {}

  list(status?: PurchaseOrderStatus): Observable<{ ok: boolean; items: PurchaseOrder[] }> {
    const statusFilter = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.http.get<{ ok: boolean; items: PurchaseOrder[] }>(`/api/purchase-orders${statusFilter}`);
  }

  getById(id: string): Observable<{ ok: boolean; order: PurchaseOrder }> {
    return this.http.get<{ ok: boolean; order: PurchaseOrder }>(`/api/purchase-orders?id=${encodeURIComponent(id)}`);
  }

  createDraft(payload: PurchaseOrderPayload): Observable<{ ok: boolean; order: PurchaseOrder }> {
    return this.http.post<{ ok: boolean; order: PurchaseOrder }>('/api/purchase-orders', {
      op: 'createDraft',
      ...payload
    });
  }

  updateDraft(id: string, payload: PurchaseOrderPayload): Observable<{ ok: boolean; order: PurchaseOrder }> {
    return this.http.post<{ ok: boolean; order: PurchaseOrder }>('/api/purchase-orders', {
      op: 'updateDraft',
      id,
      ...payload
    });
  }

  updateTracking(id: string, lines: PurchaseOrderTrackingLine[]): Observable<{ ok: boolean; order: PurchaseOrder }> {
    return this.http.post<{ ok: boolean; order: PurchaseOrder }>('/api/purchase-orders', {
      op: 'updateTracking',
      id,
      lines
    });
  }

  refreshTracking(
    id: string,
    lines: PurchaseOrderTrackingRefreshLine[]
  ): Observable<{ ok: boolean; order: PurchaseOrder; tracking: PurchaseOrderTrackingRefreshResult[] }> {
    return this.http.post<{ ok: boolean; order: PurchaseOrder; tracking: PurchaseOrderTrackingRefreshResult[] }>('/api/purchase-orders', {
      op: 'refreshTracking',
      id,
      lines
    });
  }

  submit(id: string): Observable<{ ok: boolean; order: PurchaseOrder }> {
    return this.http.post<{ ok: boolean; order: PurchaseOrder }>('/api/purchase-orders', {
      op: 'submit',
      id
    });
  }

  receive(id: string, receipts?: PurchaseOrderReceiptLine[]): Observable<{ ok: boolean; order: PurchaseOrder }> {
    return this.http.post<{ ok: boolean; order: PurchaseOrder }>('/api/purchase-orders', {
      op: 'receive',
      id,
      receipts: receipts || []
    });
  }

  deleteDraft(id: string): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>('/api/purchase-orders', {
      op: 'deleteDraft',
      id
    });
  }

  cancel(id: string): Observable<{ ok: boolean; order: PurchaseOrder }> {
    return this.http.post<{ ok: boolean; order: PurchaseOrder }>('/api/purchase-orders', {
      op: 'cancel',
      id
    });
  }

  reopenDraft(id: string): Observable<{ ok: boolean; order: PurchaseOrder }> {
    return this.http.post<{ ok: boolean; order: PurchaseOrder }>('/api/purchase-orders', {
      op: 'reopenDraft',
      id
    });
  }
}
