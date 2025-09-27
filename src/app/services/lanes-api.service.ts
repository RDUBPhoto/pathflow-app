import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export type Lane = { id: string; name: string; sort?: number };

@Injectable({ providedIn: 'root' })
export class LanesApi {
  constructor(private http: HttpClient) {}

  list() {
    return this.http.get<Lane[]>('/api/lanes');
  }

  create(name: string) {
    return this.http.post<{ ok: boolean; id: string }>('/api/lanes', { name });
  }

  rename(id: string, name: string) {
    return this.http.post<{ ok: boolean; id: string }>('/api/lanes', { id, name });
  }

  reorder(ids: string[]) {
    return this.http.post<{ ok: boolean }>('/api/lanes/reorder', { ids });
  }

  remove(id: string) {
    return this.http.delete<{ ok: boolean }>(`/api/lanes/delete/${id}`);
  }
}
