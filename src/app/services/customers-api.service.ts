import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type Customer = {
  id: string;
  name: string;
  phone?: string;
  email?: string;
};

@Injectable({ providedIn: 'root' })
export class CustomersApi {
  constructor(private http: HttpClient) {}

  list(): Observable<Customer[]> {
    return this.http.get<{ id: string; name: string; phone?: string; email?: string }[]>('/api/customers');
  }

  upsert(body: Omit<Customer, 'id'> & { id?: string }): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>('/api/customers', body);
  }

}
