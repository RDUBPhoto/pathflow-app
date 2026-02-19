import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, map, Observable, of } from 'rxjs';

type SettingResponse<T> = {
  ok: boolean;
  tenantId: string;
  key: string;
  value: T;
  updatedAt: string;
};

type SettingsListResponse = {
  ok: boolean;
  tenantId: string;
  items: Array<{ key: string; value: unknown; updatedAt: string }>;
};

@Injectable({ providedIn: 'root' })
export class AppSettingsApiService {
  private readonly http = inject(HttpClient);

  getValue<T>(key: string): Observable<T | null> {
    return this.http.get<SettingResponse<T>>(`/api/settings?key=${encodeURIComponent(key)}`).pipe(
      map(res => (res && Object.prototype.hasOwnProperty.call(res, 'value') ? (res.value as T) : null)),
      catchError(() => of(null))
    );
  }

  setValue<T>(key: string, value: T): Observable<SettingResponse<T>> {
    return this.http.post<SettingResponse<T>>('/api/settings', {
      op: 'set',
      key,
      value
    });
  }

  deleteValue(key: string): Observable<{ ok: boolean; tenantId: string; key: string; deleted: boolean }> {
    return this.http.post<{ ok: boolean; tenantId: string; key: string; deleted: boolean }>('/api/settings', {
      op: 'delete',
      key
    });
  }

  listValues(): Observable<Record<string, unknown>> {
    return this.http.get<SettingsListResponse>('/api/settings').pipe(
      map(res => {
        const mapValue: Record<string, unknown> = {};
        const items = Array.isArray(res?.items) ? res.items : [];
        for (const item of items) {
          const key = String(item?.key || '').trim();
          if (!key) continue;
          mapValue[key] = item?.value;
        }
        return mapValue;
      }),
      catchError(() => of({}))
    );
  }
}
