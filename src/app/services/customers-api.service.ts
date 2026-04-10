import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, concatMap, from, map, of, reduce, timeout } from 'rxjs';

export type Customer = {
  id: string;
  business?: string;
  accountManager?: string;
  creator?: string;
  position?: string;
  title?: string;
  name: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  mobile?: string;
  email?: string;
  secondaryEmail?: string;
  address?: string;
  address1?: string;
  address2?: string;
  address3?: string;
  town?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  accountReference?: string;
  priceList?: string;
  paymentTerm?: string;
  lastQuoteActivity?: string;
  lastJobActivity?: string;
  lastInvoiceActivity?: string;
  lastOpportunityActivity?: string;
  lastTaskActivity?: string;
  dateLeft?: string;
  tags?: string;
  contactTags?: string;
  vin?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleYear?: string;
  vehicleTrim?: string;
  vehicleDoors?: string;
  bedLength?: string;
  cabType?: string;
  engineModel?: string;
  engineCylinders?: string;
  transmissionStyle?: string;
  boltPattern?: string;
  rearBoltPattern?: string;
  pcd?: string;
  rearPcd?: string;
  centreBore?: string;
  wheelFasteners?: string;
  wheelTorque?: string;
  frontTireSize?: string;
  rearTireSize?: string;
  frontRimSize?: string;
  rearRimSize?: string;
  vehicleColor?: string;
  smsConsentStatus?: string;
  smsConsentProvidedAt?: string;
  smsConsentConfirmedAt?: string;
  smsConsentRevokedAt?: string;
  smsConsentPromptSentAt?: string;
  smsConsentPromptMessageId?: string;
  smsConsentPromptError?: string;
  smsConsentExpectedKeyword?: string;
  smsConsentMethod?: string;
  smsConsentSource?: string;
  smsConsentVersion?: string;
  smsConsentText?: string;
  smsConsentPageUrl?: string;
  smsConsentIp?: string;
  smsConsentKeyword?: string;
  smsConsentLastKeywordAt?: string;
  smsConsentUpdatedAt?: string;
  notes?: string;
  notesHistory?: Array<{
    id?: string;
    text?: string;
    createdAt?: string;
    createdBy?: string;
    createdById?: string;
  }>;
  createdAt?: string;
  updatedAt?: string;
};

export type DuplicateReason = 'vin' | 'email' | 'phone' | 'name';
export type DuplicateRecommendation = 'auto-merge' | 'review' | 'no-match';

export type DuplicateCandidate = {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  secondaryEmail?: string;
  phone?: string;
  score: number;
  confidence?: number;
  recommendation?: DuplicateRecommendation;
  reasons: DuplicateReason[];
};

export type DuplicateCheckResponse = {
  ok: boolean;
  items: DuplicateCandidate[];
};

export type MergeCustomerResponse = {
  ok: boolean;
  merged: boolean;
  id: string;
  remapped?: Record<string, number>;
  sourceDeleted?: boolean;
  customer?: Customer;
};

export type DuplicatePair = {
  leftId: string;
  rightId: string;
  score: number;
  confidence?: number;
  recommendation?: DuplicateRecommendation;
  reasons: DuplicateReason[];
};

export type DuplicateSummaryResponse = {
  ok: boolean;
  total: number;
  pairs: DuplicatePair[];
  customersById?: Record<string, Partial<Customer>>;
};

export type CustomerImportRow = Partial<Omit<Customer, 'id'>>;

export type CustomerImportResponse = {
  ok: boolean;
  created: number;
  updated: number;
  skipped: number;
  errors: Array<{ index: number; error: string }>;
};

@Injectable({ providedIn: 'root' })
export class CustomersApi {
  private readonly importBatchSize = 100;
  private readonly importRequestTimeoutMs = 5 * 60 * 1000;

  constructor(private http: HttpClient) {}

  list(): Observable<Customer[]> {
    return this.http.get<any>('/api/customers').pipe(
      map(res => {
        if (Array.isArray(res)) return res as Customer[];
        if (Array.isArray(res?.value)) return res.value as Customer[];
        if (Array.isArray(res?.items)) return res.items as Customer[];
        return [];
      })
    );
  }

  upsert(body: Omit<Customer, 'id'> & { id?: string }): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>('/api/customers', body);
  }

  findDuplicates(body: Partial<Omit<Customer, 'id'>> & { excludeId?: string; id?: string }): Observable<DuplicateCheckResponse> {
    return this.http.post<DuplicateCheckResponse>('/api/customers', {
      op: 'findDuplicates',
      ...body
    });
  }

  mergeCustomers(targetId: string, sourceId: string): Observable<MergeCustomerResponse> {
    return this.http.post<MergeCustomerResponse>('/api/customers', {
      op: 'merge',
      targetId,
      sourceId
    });
  }

  mergeDraftInto(targetId: string, draft: Omit<Customer, 'id'> & { id?: string }): Observable<MergeCustomerResponse> {
    const { id: _ignoredId, ...rest } = draft;
    return this.http.post<MergeCustomerResponse>('/api/customers', {
      op: 'mergeDraft',
      targetId,
      ...rest
    });
  }

  duplicateSummary(limit = 25, includeCustomers = false): Observable<DuplicateSummaryResponse> {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 200));
    return this.http.post<DuplicateSummaryResponse>('/api/customers', {
      op: 'duplicateSummary',
      limit: safeLimit,
      includeCustomers: !!includeCustomers
    }).pipe(
      map(res => ({
        ok: res?.ok !== false,
        total: Number(res?.total || 0),
        pairs: Array.isArray(res?.pairs) ? res.pairs : [],
        customersById: (res?.customersById && typeof res.customersById === 'object') ? res.customersById : {}
      }))
    );
  }

  markNotDuplicate(leftId: string, rightId: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/customers', {
      op: 'markNotDuplicate',
      leftId,
      rightId
    });
  }

  importRows(rows: CustomerImportRow[]): Observable<CustomerImportResponse> {
    if (!rows.length) {
      return of({
        ok: true,
        created: 0,
        updated: 0,
        skipped: 0,
        errors: []
      });
    }

    const batches: CustomerImportRow[][] = [];
    for (let i = 0; i < rows.length; i += this.importBatchSize) {
      batches.push(rows.slice(i, i + this.importBatchSize));
    }

    return from(batches).pipe(
      concatMap((batch, batchIndex) =>
        this.http.post<CustomerImportResponse>('/api/customers', {
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
      reduce<CustomerImportResponse, CustomerImportResponse>(
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

  delete(id: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/customers', { id, op: 'delete' });
  }

  getById(id: string): Observable<Customer | null> {
    return this.list().pipe(
      map(list => list.find(customer => customer.id === id) ?? null)
    );
  }
}
