import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { map, Observable } from 'rxjs';
import { AppSettingsApiService } from './app-settings-api.service';
import { normalizeShopTimeZone, SCHEDULE_SETTINGS_KEY } from '../utils/shop-time';

export type ScheduleItem = {
  id: string;
  start: string;
  end: string;
  actualEnd?: string;
  bayReleasedAt?: string;
  resource: string;
  customerId?: string;
  workItemId?: string;
  vehicle?: string;
  vehicleId?: string;
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
  appointmentInfoSentAt?: string;
  appointmentInfoSentVia?: string;
  appointmentInfoMessage?: string;
  appointmentInfoSentScheduleStart?: string;
  appointmentInfoSentScheduleEnd?: string;
  appointmentInfoSentResource?: string;
  createdAt?: string;
  updatedAt?: string;
};

@Injectable({ providedIn: 'root' })
export class ScheduleApi {
  constructor(private http: HttpClient, private settingsApi: AppSettingsApiService) {}

  getShopTimeZone(): Observable<string> {
    return this.settingsApi.getValue<{ timeZone?: string }>(SCHEDULE_SETTINGS_KEY).pipe(
      map(settings => normalizeShopTimeZone(settings?.timeZone))
    );
  }

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
