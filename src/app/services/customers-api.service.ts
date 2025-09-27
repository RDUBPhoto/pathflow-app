import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export type Customer = { id: string; name: string; phone: string; email: string };
type UpsertRes = { ok: boolean; id: string };

@Injectable({ providedIn: 'root' })
export class CustomersApi {
  private base =
    typeof window !== 'undefined' && location.hostname === 'localhost'
      ? 'https://happy-desert-01944f00f.1.azurestaticapps.net'
      : '';

  constructor(private http: HttpClient) {}

  list() {
    return this.http.get<Customer[]>(`${this.base}/api/customers`);
  }

  upsert(payload: Partial<Customer>) {
    return this.http.post<UpsertRes>(`${this.base}/api/customers`, payload);
  }
}
