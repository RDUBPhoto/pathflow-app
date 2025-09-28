import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type Lane = { id: string; name: string; sort?: number };

@Injectable({ providedIn: 'root' })
export class LanesApi {
  constructor(private http: HttpClient) {}

  list(): Observable<Lane[]> { return this.http.get<Lane[]>('/api/lanes'); }
  create(name: string) { return this.http.post<{ ok: boolean; id: string }>('/api/lanes', { name }); }
  reorder(ids: string[]) { return this.http.post<{ ok: boolean }>('/api/lanes-reorder', { ids }); }
  update(id: string, name: string) { return this.http.post<{ ok: boolean; id: string }>('/api/lanes', { id, name }); }
  delete(id: string) {
    return this.http.post<{ ok: boolean }>('/api/lanes-delete', { id });
  }
}
