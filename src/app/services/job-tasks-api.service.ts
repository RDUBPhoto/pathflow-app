import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export type JobTaskStatus = 'open' | 'in_progress' | 'completed' | 'cancelled';
export type JobTaskPriority = 'low' | 'normal' | 'high';
export type JobTaskType = 'parts-readiness' | 'parts-pull' | 'manual' | string;

export type JobTask = {
  id: string;
  taskType?: JobTaskType;
  jobId?: string;
  jobNumber?: string;
  relatedScheduleId?: string;
  relatedWorkItemId?: string;
  customerName?: string;
  vehicle?: string;
  title: string;
  description?: string;
  assignedRole?: string;
  ownerRole?: string;
  ownerUser?: string;
  dueDate?: string;
  priority: JobTaskPriority;
  status: JobTaskStatus;
  comments?: string;
  warning?: string;
  completedAt?: string;
  completedBy?: string;
  completedById?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type JobTaskPayload = Partial<JobTask> & {
  parts?: unknown[];
  additionalParts?: unknown[];
  installDate?: string;
};

export type JobTaskQuery = {
  jobId?: string;
  jobNumber?: string;
  scheduleId?: string;
  workItemId?: string;
  status?: JobTaskStatus | 'all';
};

@Injectable({ providedIn: 'root' })
export class JobTasksApiService {
  constructor(private readonly http: HttpClient) {}

  list(query: JobTaskQuery = {}): Observable<{ ok: boolean; tasks: JobTask[] }> {
    const params = new URLSearchParams();
    if (query.jobId) params.set('jobId', query.jobId);
    if (query.jobNumber) params.set('jobNumber', query.jobNumber);
    if (query.scheduleId) params.set('scheduleId', query.scheduleId);
    if (query.workItemId) params.set('workItemId', query.workItemId);
    if (query.status) params.set('status', query.status);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    return this.http.get<{ ok: boolean; tasks: JobTask[] }>(`/api/job-tasks${suffix}`);
  }

  ensurePartsTasks(payload: JobTaskPayload): Observable<{ ok: boolean; tasks: JobTask[] }> {
    return this.http.post<{ ok: boolean; tasks: JobTask[] }>('/api/job-tasks', {
      op: 'ensurePartsTasks',
      ...payload
    });
  }

  update(id: string, payload: JobTaskPayload): Observable<{ ok: boolean; task: JobTask }> {
    return this.http.post<{ ok: boolean; task: JobTask }>('/api/job-tasks', {
      op: 'update',
      id,
      ...payload
    });
  }

  complete(id: string, payload: JobTaskPayload = {}): Observable<{ ok: boolean; task: JobTask }> {
    return this.http.post<{ ok: boolean; task: JobTask }>('/api/job-tasks', {
      op: 'complete',
      id,
      ...payload
    });
  }
}
