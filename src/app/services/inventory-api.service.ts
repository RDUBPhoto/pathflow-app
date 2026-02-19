import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type InventoryItem = {
  id: string;
  name: string;
  sku: string;
  vendor: string;
  category: string;
  onHand: number;
  reorderAt: number;
  onOrder: number;
  unitCost: number;
  lastUpdated: string;
  createdAt?: string;
  updatedAt?: string;
};

export type InventoryNeedStatus = 'needs-order' | 'po-draft' | 'ordered' | 'received' | 'cancelled';

export type InventoryNeed = {
  id: string;
  sourceType: string;
  sourceId: string;
  scheduleStart: string;
  scheduleEnd: string;
  resource: string;
  customerId: string | null;
  customerName: string | null;
  vehicle: string;
  partName: string;
  sku: string;
  qty: number;
  vendorHint: string;
  note: string;
  status: InventoryNeedStatus;
  purchaseOrderId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InventoryConnectorStatus =
  | 'connected'
  | 'error'
  | 'not-connected'
  | 'partner-only'
  | 'planned';

export type InventoryConnector = {
  id: string;
  provider: string;
  segment: string;
  status: InventoryConnectorStatus;
  note: string;
  enabled: boolean;
  configured: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
};

export type NexpartRuntime = {
  provider: 'nexpart';
  enabled: boolean;
  configured: boolean;
  readyForLive: boolean;
  baseUrl: string;
  searchPath: string;
  pingPath: string;
  account: string;
  hasApiKey: boolean;
  hasBearerToken: boolean;
};

export type InventoryStateResponse = {
  ok: boolean;
  items: InventoryItem[];
  needs: InventoryNeed[];
  connectors: InventoryConnector[];
  summary: {
    lowStockCount: number;
    totalOnHand: number;
    totalOnOrder: number;
    totalInventoryValue: number;
    pendingNeeds: number;
  };
  nexpart: NexpartRuntime;
};

export type NexpartSearchItem = {
  id: string;
  partNumber: string;
  description: string;
  brand: string;
  supplier: string;
  availability: string | null;
  price: number | null;
  raw: Record<string, unknown>;
};

export type NexpartSearchResponse = {
  ok: boolean;
  provider: 'nexpart';
  sourceStatus: number;
  rawCount: number;
  items: NexpartSearchItem[];
};

@Injectable({ providedIn: 'root' })
export class InventoryApiService {
  constructor(private readonly http: HttpClient) {}

  getState(status?: string): Observable<InventoryStateResponse> {
    const statusFilter = status ? `?status=${encodeURIComponent(status)}` : '';
    return this.http.get<InventoryStateResponse>(`/api/inventory${statusFilter}`);
  }

  listItems(): Observable<{ ok: boolean; scope: 'items'; items: InventoryItem[] }> {
    return this.http.get<{ ok: boolean; scope: 'items'; items: InventoryItem[] }>('/api/inventory?scope=items');
  }

  listNeeds(status?: string): Observable<{ ok: boolean; scope: 'needs'; needs: InventoryNeed[] }> {
    const statusFilter = status ? `&status=${encodeURIComponent(status)}` : '';
    return this.http.get<{ ok: boolean; scope: 'needs'; needs: InventoryNeed[] }>(
      `/api/inventory?scope=needs${statusFilter}`
    );
  }

  upsertItem(payload: Partial<InventoryItem> & { id?: string; name?: string; sku?: string }): Observable<{ ok: boolean; item: InventoryItem }> {
    return this.http.post<{ ok: boolean; item: InventoryItem }>('/api/inventory', {
      op: 'upsertItem',
      ...payload
    });
  }

  deleteItem(id: string): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>('/api/inventory', { op: 'deleteItem', id });
  }

  setNeedStatus(id: string, status: InventoryNeedStatus, purchaseOrderId?: string): Observable<{ ok: boolean; need: InventoryNeed }> {
    return this.http.post<{ ok: boolean; need: InventoryNeed }>('/api/inventory', {
      op: 'setNeedStatus',
      id,
      status,
      purchaseOrderId: purchaseOrderId || ''
    });
  }

  upsertConnector(payload: Partial<InventoryConnector> & { id: string }): Observable<{ ok: boolean; connector: InventoryConnector }> {
    return this.http.post<{ ok: boolean; connector: InventoryConnector }>('/api/inventory', {
      op: 'upsertConnector',
      ...payload
    });
  }

  nexpartPing(query?: string): Observable<{ ok: boolean; provider: 'nexpart'; connected: boolean; statusCode?: number; checkedAt: string; error?: string }> {
    return this.http.post<{ ok: boolean; provider: 'nexpart'; connected: boolean; statusCode?: number; checkedAt: string; error?: string }>(
      '/api/inventory',
      { op: 'nexpartPing', query: query || '' }
    );
  }

  nexpartSearch(query: string, limit = 15): Observable<NexpartSearchResponse> {
    return this.http.post<NexpartSearchResponse>('/api/inventory', {
      op: 'nexpartSearch',
      query,
      limit
    });
  }
}
