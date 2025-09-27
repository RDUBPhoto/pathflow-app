import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export type Customer = { id: string; name: string; phone: string; email: string };
type UpsertRes = { ok: boolean; id: string };

@Injectable({ providedIn: 'root' })
export class CustomersApi {
  constructor(private http: HttpClient) {}

  list() {
    return this.http.get<Customer[]>('/api/customers');
  }

  upsert(payload: Partial<Customer>) {
    return this.http.post<UpsertRes>('/api/customers', payload);
  }
}