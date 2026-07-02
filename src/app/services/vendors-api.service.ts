import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type Vendor = {
  id: string;
  name: string;
  normalizedName?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  website?: string;
  accountNumber?: string;
  notes?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
};

export type VendorPayload = Partial<Vendor> & {
  name: string;
};

@Injectable({ providedIn: 'root' })
export class VendorsApiService {
  constructor(private readonly http: HttpClient) {}

  list(query = '', includeInactive = false): Observable<{ ok: boolean; vendors: Vendor[] }> {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (includeInactive) params.set('includeInactive', 'true');
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.http.get<{ ok: boolean; vendors: Vendor[] }>(`/api/vendors${suffix}`);
  }

  create(payload: VendorPayload): Observable<{ ok: boolean; vendor: Vendor }> {
    return this.http.post<{ ok: boolean; vendor: Vendor }>('/api/vendors', {
      op: 'create',
      ...payload
    });
  }

  update(id: string, payload: VendorPayload): Observable<{ ok: boolean; vendor: Vendor }> {
    return this.http.post<{ ok: boolean; vendor: Vendor }>('/api/vendors', {
      op: 'update',
      id,
      ...payload
    });
  }

  archive(id: string): Observable<{ ok: boolean; vendor: Vendor }> {
    return this.http.post<{ ok: boolean; vendor: Vendor }>('/api/vendors', {
      op: 'archive',
      id
    });
  }
}
