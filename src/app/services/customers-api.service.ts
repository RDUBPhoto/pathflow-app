import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map } from 'rxjs';

export type Customer = {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  address?: string;
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
  createdAt?: string;
  updatedAt?: string;
};

export type DuplicateReason = 'email' | 'phone' | 'name';

export type DuplicateCandidate = {
  id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  score: number;
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

@Injectable({ providedIn: 'root' })
export class CustomersApi {
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

  delete(id: string): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/customers', { id, op: 'delete' });
  }

  getById(id: string): Observable<Customer | null> {
    return this.list().pipe(
      map(list => list.find(customer => customer.id === id) ?? null)
    );
  }
}
