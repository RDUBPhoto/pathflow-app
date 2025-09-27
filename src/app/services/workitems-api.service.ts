import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';

export type WorkItem = {
  id: string;
  laneId: string;
  title: string;
  customerId?: string;
  sort?: number;
  createdAt?: string;
};

@Injectable({ providedIn: 'root' })
export class WorkItemsApi {
  constructor(private http: HttpClient) {}

  list(laneId?: string) {
    let params = new HttpParams();
    if (laneId) params = params.set('laneId', laneId);
    return this.http.get<WorkItem[]>('/api/workitems', { params });
  }

  create(title: string, laneId: string, customerId?: string) {
    return this.http.post<{ ok: boolean; id: string }>('/api/workitems', { title, laneId, customerId });
  }

  update(patch: Partial<WorkItem> & { id: string }) {
    return this.http.post<{ ok: boolean; id: string; moved?: boolean }>('/api/workitems', patch);
  }

  reorder(laneId: string, ids: string[]) {
    return this.http.post<{ ok: boolean }>('/api/workitems/reorder', { laneId, ids });
  }

  remove(id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/workitems/${id}`);
  }
}