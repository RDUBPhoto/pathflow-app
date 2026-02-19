import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type PurchaseOrderStatus = 'draft' | 'ordered' | 'received' | 'cancelled';

export type PurchaseOrderLine = {
  lineId?: string;
  needId?: string;
  itemId?: string;
  partName: string;
  sku?: string;
  vendor?: string;
  qty: number;
  unitCost?: number;
  note?: string;
  lineTotal?: number;
};

export type PurchaseOrder = {
  id: string;
  supplier: string;
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
  note?: string;
  currency?: string;
  lines?: PurchaseOrderLine[];
  needIds?: string[];
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

  submit(id: string): Observable<{ ok: boolean; order: PurchaseOrder }> {
    return this.http.post<{ ok: boolean; order: PurchaseOrder }>('/api/purchase-orders', {
      op: 'submit',
      id
    });
  }

  receive(id: string): Observable<{ ok: boolean; order: PurchaseOrder }> {
    return this.http.post<{ ok: boolean; order: PurchaseOrder }>('/api/purchase-orders', {
      op: 'receive',
      id
    });
  }

  deleteDraft(id: string): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>('/api/purchase-orders', {
      op: 'deleteDraft',
      id
    });
  }
}
