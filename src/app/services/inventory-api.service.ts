import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, concatMap, from, map, mergeMap, of, reduce, throwError, timeout } from 'rxjs';

export type InventoryItem = {
  id: string;
  name: string;
  sku: string;
  vendor: string;
  category: string;
  unit?: string;
  accountCode?: string;
  purchaseAccountCode?: string;
  salesTaxCode?: string;
  purchaseTaxCode?: string;
  discountPercent?: number;
  cost?: number;
  price?: number;
  onHand: number;
  reorderAt: number;
  onOrder: number;
  unitCost: number;
  lastUpdated: string;
  createdAt?: string;
  updatedAt?: string;
};

export type InventoryImportRow = Partial<{
  partLaborCode: string;
  category: string;
  description: string;
  unit: string;
  accountCode: string;
  purchaseAccountCode: string;
  salesTaxCode: string;
  purchaseTaxCode: string;
  mainSupplier: string;
  discountPercent: number;
  freeStock: number;
  cost: number;
  price: number;

  // Backward-compatible aliases
  name: string;
  sku: string;
  vendor: string;
  onHand: number;
  reorderAt: number;
  onOrder: number;
  unitCost: number;
}>;

export type InventoryImportResponse = {
  ok: boolean;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ index: number; error: string }>;
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
  private readonly importBatchSize = 2000;
  private readonly legacyUpsertConcurrency = 20;
  private readonly importRequestTimeoutMs = 5 * 60 * 1000;

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

  importRows(rows: InventoryImportRow[]): Observable<InventoryImportResponse> {
    if (!rows.length) {
      return of({
        ok: true,
        created: 0,
        updated: 0,
        skipped: 0,
        errors: []
      });
    }

    const batches: InventoryImportRow[][] = [];
    for (let i = 0; i < rows.length; i += this.importBatchSize) {
      batches.push(rows.slice(i, i + this.importBatchSize));
    }

    return this.runBatchImport(rows, batches).pipe(
      catchError(err => {
        if (!this.isUnknownOperationError(err)) {
          return throwError(() => err);
        }
        return this.runLegacyUpsertImport(rows);
      })
    );
  }

  private runBatchImport(rows: InventoryImportRow[], batches: InventoryImportRow[][]): Observable<InventoryImportResponse> {
    return from(batches).pipe(
      concatMap((batch, batchIndex) =>
        this.http.post<InventoryImportResponse>('/api/inventory', {
          op: 'import',
          rows: batch
        }).pipe(
          timeout(this.importRequestTimeoutMs),
          map(result => ({
            ok: result?.ok !== false,
            created: Number(result?.created || 0),
            updated: Number(result?.updated || 0),
            skipped: Number(result?.skipped || 0),
            errors: (Array.isArray(result?.errors) ? result.errors : []).map(error => ({
              index: Number(error?.index || 0) + (batchIndex * this.importBatchSize),
              error: String(error?.error || 'Unknown import error')
            }))
          }))
        )
      ),
      reduce<InventoryImportResponse, InventoryImportResponse>(
        (acc, chunk) => ({
          ok: acc.ok && chunk.ok,
          created: acc.created + chunk.created,
          updated: acc.updated + chunk.updated,
          skipped: acc.skipped + chunk.skipped,
          errors: acc.errors.concat(chunk.errors)
        }),
        { ok: true, created: 0, updated: 0, skipped: 0, errors: [] }
      )
    );
  }

  private runLegacyUpsertImport(rows: InventoryImportRow[]): Observable<InventoryImportResponse> {
    return from(rows.map((row, index) => ({ row, index }))).pipe(
      mergeMap(({ row, index }) => {
        const payload = this.toLegacyUpsertPayload(row);
        if (!payload.name && !payload.sku) {
          return of<InventoryImportResponse>({
            ok: true,
            created: 0,
            updated: 0,
            skipped: 1,
            errors: []
          });
        }
        return this.http.post<{ ok: boolean; item?: InventoryItem }>('/api/inventory', {
          op: 'upsertItem',
          ...payload
        }).pipe(
          timeout(this.importRequestTimeoutMs),
          map(() => ({
            ok: true,
            created: 0,
            updated: 1,
            skipped: 0,
            errors: []
          }) as InventoryImportResponse),
          catchError(err =>
            of<InventoryImportResponse>({
              ok: false,
              created: 0,
              updated: 0,
              skipped: 0,
              errors: [{
                index,
                error: this.extractErrorMessage(err) || 'Legacy upsert import failed.'
              }]
            })
          )
        );
      }, this.legacyUpsertConcurrency),
      reduce<InventoryImportResponse, InventoryImportResponse>(
        (acc, chunk) => ({
          ok: acc.ok && chunk.ok,
          created: acc.created + chunk.created,
          updated: acc.updated + chunk.updated,
          skipped: acc.skipped + chunk.skipped,
          errors: acc.errors.concat(chunk.errors)
        }),
        { ok: true, created: 0, updated: 0, skipped: 0, errors: [] }
      )
    );
  }

  private toLegacyUpsertPayload(row: InventoryImportRow): Partial<InventoryItem> & { name?: string; sku?: string } {
    const sku = this.asText(row.partLaborCode ?? row.sku);
    const name = this.asText(row.description ?? row.name);
    const vendor = this.asText(row.mainSupplier ?? row.vendor);
    const onHand = this.asNumber(row.freeStock ?? row.onHand, 0);
    const cost = this.asNumber(row.cost, 0);
    const price = this.asNumber(row.price, 0);
    const unitCost = this.asNumber(row.unitCost, price || cost || 0);

    return {
      name,
      sku,
      vendor,
      category: this.asText(row.category),
      unit: this.asText(row.unit),
      accountCode: this.asText(row.accountCode),
      purchaseAccountCode: this.asText(row.purchaseAccountCode),
      salesTaxCode: this.asText(row.salesTaxCode),
      purchaseTaxCode: this.asText(row.purchaseTaxCode),
      discountPercent: this.asNumber(row.discountPercent, 0),
      cost,
      price,
      onHand,
      reorderAt: this.asNumber(row.reorderAt, 0),
      onOrder: this.asNumber(row.onOrder, 0),
      unitCost
    };
  }

  private isUnknownOperationError(err: unknown): boolean {
    const message = this.extractErrorMessage(err).toLowerCase();
    return message.includes('unknown operation');
  }

  private extractErrorMessage(err: any): string {
    return String(err?.error?.error || err?.error?.detail || err?.message || '').trim();
  }

  private asText(value: unknown): string {
    return String(value ?? '').trim();
  }

  private asNumber(value: unknown, fallback = 0): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const cleaned = String(value ?? '')
      .replace(/[$,%\s]/g, '')
      .replace(/,/g, '')
      .trim();
    if (!cleaned) return fallback;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
