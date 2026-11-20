import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type WorkItem = {
  id: string;
  title: string;
  laneId: string;
  customerId?: string;
  invoiceId?: string;
  jobId?: string;
  dashboardHidden?: boolean;
  customerName?: string;
  source?: string;
  leadSource?: string;
  intakeSource?: string;
  origin?: string;
  channel?: string;
  contactEmail?: string;
  contactPhone?: string;
  message?: string;
  notes?: string;
  customerNote?: string;
  vin?: string;
  vehicleId?: string;
  vehicleColor?: string;
  vehicleYear?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleTrim?: string;
  mileageIn?: number | null;
  mileageOut?: number | null;
  mileageInRecordedAt?: string;
  mileageOutRecordedAt?: string;
  sort?: number;
  createdAt?: string;
  updatedAt?: string;
  checkedInAt?: string;
  completedAt?: string;
  pickedUpAt?: string;
  calendarOverrideAt?: string;
  isPaused?: boolean;
  pausedAt?: string;
  lastWorkResumedAt?: string;
  workDurationMs?: number;
  activeWorkDurationMs?: number;
  workClockState?: 'not-started' | 'working' | 'after-hours' | 'paused' | 'completed';
  pauseDurationMs?: number;
};

export type WorkClockAction = 'check-in' | 'start' | 'pause' | 'resume';

export function workItemDocumentRef(item: WorkItem): string {
  return item.invoiceId?.trim() || item.title?.match(/\[doc=([^\]]+)\]/i)?.[1]?.trim() || '';
}

@Injectable({ providedIn: 'root' })
export class WorkItemsApi {
  constructor(private http: HttpClient) {}

  list(customerId?: string): Observable<WorkItem[]> {
    return this.http.get<WorkItem[]>('/api/workitems', { params: customerId ? { customerId } : {} });
  }

  create(title: string, laneId: string, intake?: { source: 'phone'; message: string; customerId: string }): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>('/api/workitems', { title, laneId, ...intake });
  }

  update(body: Partial<WorkItem> & { id: string; workClockAction?: WorkClockAction; markPickedUp?: boolean }): Observable<{ ok: boolean; id: string; moved?: boolean }> {
    return this.http.post<{ ok: boolean; id: string; moved?: boolean }>('/api/workitems', body);
  }

  setDashboardHidden(id: string, dashboardHidden: boolean): Observable<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>('/api/workitems', { op: 'set-dashboard-visibility', id, dashboardHidden }, {
      headers: { 'x-skip-action-toast': '1' }
    });
  }

  reorder(laneId: string, ids: string[]): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/api/workitems-reorder', { laneId, ids });
  }

  delete(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/workitems/${id}`);
  }
}
