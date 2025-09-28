import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type WorkItem = { id: string; title: string; laneId: string; customerId?: string; sort?: number; createdAt?: string };

@Injectable({ providedIn: 'root' })
export class WorkItemsApi {
  constructor(private http: HttpClient) {}

  list(): Observable<WorkItem[]> {
    return this.http.get<WorkItem[]>('/api/workitems');
  }

  create(title: string, laneId: string): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>('/api/workitems', { title, laneId });
  }

  update(body: Partial<WorkItem> & { id: string }): Observable<{ ok: boolean; id: string; moved?: boolean }> {
    return this.http.post<{ ok: boolean; id: string; moved?: boolean }>('/api/workitems', body);
  }

  reorder(laneId: string, ids: string[]): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/workitems-reorder', { laneId, ids });
  }

  delete(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/workitems/${id}`);
  }
}