import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type ScheduleItem = {
  id: string;
  start: string;
  end: string;
  resource: string;
  customerId?: string;
  isBlocked?: boolean;
  title?: string;
  notes?: string;
  partRequests?: Array<{
    partName: string;
    qty: number;
    vendorHint?: string;
    sku?: string;
    note?: string;
  }>;
  createdAt?: string;
  updatedAt?: string;
};

@Injectable({ providedIn: 'root' })
export class ScheduleApi {
  constructor(private http: HttpClient) {}

  list(): Observable<ScheduleItem[]> {
    return this.http.get<ScheduleItem[]>('/api/schedule');
  }

  create(body: Omit<ScheduleItem, 'id'>): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>('/api/schedule', body);
  }

  update(body: Partial<ScheduleItem> & { id: string }): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>('/api/schedule', body);
  }

  delete(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/schedule/${id}`);
  }
}
