import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export interface WorkspaceUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  status: 'active' | 'invited' | 'disabled';
}

type UsersResponse = {
  ok: boolean;
  items: WorkspaceUser[];
  tenantId: string;
};

type MessageResponse = {
  ok: boolean;
  message?: string;
  error?: string;
};

@Injectable({ providedIn: 'root' })
export class AccessAdminApiService {
  constructor(private readonly http: HttpClient) {}

  listUsers(tenantId?: string) {
    const query = tenantId ? `?scope=users&tenantId=${encodeURIComponent(tenantId)}` : '?scope=users';
    return this.http.get<UsersResponse>(`/api/access${query}`);
  }

  inviteUser(payload: { name: string; email: string; role: 'admin' | 'user'; tenantId?: string }) {
    return this.http.post<UsersResponse>('/api/access', {
      op: 'invite-user',
      ...payload
    });
  }

  removeUserAccess(payload: { email: string; tenantId?: string }) {
    return this.http.post<UsersResponse>('/api/access', {
      op: 'remove-user-access',
      ...payload
    });
  }

  resetUserPassword(payload: { email: string; tenantId?: string }) {
    return this.http.post<MessageResponse>('/api/access', {
      op: 'reset-user-password',
      ...payload
    });
  }

  requestPasswordReset(payload: { email: string; tenantId?: string }) {
    return this.http.post<MessageResponse>('/api/access', {
      op: 'request-password-reset',
      ...payload
    });
  }

  changeMyPassword(payload: { newPassword: string }) {
    return this.http.post<MessageResponse>('/api/access', {
      op: 'change-my-password',
      ...payload
    });
  }
}
