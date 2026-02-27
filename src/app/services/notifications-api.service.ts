import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { AuthService } from '../auth/auth.service';

export type AppNotificationType = 'mention' | string;

export type AppNotification = {
  id: string;
  tenantId: string;
  type: AppNotificationType;
  title: string;
  message: string;
  route: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  targetUserId: string | null;
  targetEmail: string | null;
  targetDisplayName: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  actorDisplayName: string | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
};

export type MentionableUser = {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
};

type NotificationsRecentResponse = {
  ok: boolean;
  scope: 'recent';
  unreadCount: number;
  total: number;
  hasMore: boolean;
  items: AppNotification[];
};

type NotificationsAllResponse = {
  ok: boolean;
  scope: 'all';
  unreadCount: number;
  total: number;
  items: AppNotification[];
};

type NotificationsUnreadCountResponse = {
  ok: boolean;
  scope: 'unreadCount';
  unreadCount: number;
};

type NotificationsMentionableUsersResponse = {
  ok: boolean;
  scope: 'users';
  items: MentionableUser[];
};

type NotificationsCreateResponse = {
  ok: boolean;
  scope: 'createMention';
  item: AppNotification;
};

@Injectable({ providedIn: 'root' })
export class NotificationsApiService {
  private readonly auth = inject(AuthService);

  constructor(private readonly http: HttpClient) {}

  listRecent(limit = 3): Observable<NotificationsRecentResponse> {
    const params = this.withActorParams(
      new HttpParams()
        .set('scope', 'recent')
        .set('limit', String(this.normalizeLimit(limit, 3)))
    );
    return this.http.get<NotificationsRecentResponse>('/api/notifications', { params });
  }

  listAll(limit = 100): Observable<NotificationsAllResponse> {
    const params = this.withActorParams(
      new HttpParams()
        .set('scope', 'all')
        .set('limit', String(this.normalizeLimit(limit, 100)))
    );
    return this.http.get<NotificationsAllResponse>('/api/notifications', { params });
  }

  unreadCount(): Observable<NotificationsUnreadCountResponse> {
    const params = this.withActorParams(new HttpParams().set('scope', 'unreadCount'));
    return this.http.get<NotificationsUnreadCountResponse>('/api/notifications', { params });
  }

  listMentionableUsers(search = ''): Observable<NotificationsMentionableUsersResponse> {
    let params = this.withActorParams(new HttpParams().set('scope', 'users'));
    const trimmed = search.trim();
    if (trimmed) {
      params = params.set('search', trimmed);
    }
    return this.http.get<NotificationsMentionableUsersResponse>('/api/notifications', { params });
  }

  createMention(payload: {
    targetUserId?: string;
    targetEmail?: string;
    targetDisplayName?: string;
    title: string;
    message: string;
    route: string;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
  }): Observable<NotificationsCreateResponse> {
    return this.http.post<NotificationsCreateResponse>('/api/notifications', this.withActorBody({
      op: 'createMention',
      ...payload
    }));
  }

  markRead(id: string): Observable<{ ok: boolean; id: string; updated: boolean }> {
    return this.http.post<{ ok: boolean; id: string; updated: boolean }>(
      '/api/notifications',
      this.withActorBody({ op: 'markRead', id })
    );
  }

  markReadBatch(ids: string[]): Observable<{ ok: boolean; updated: number }> {
    return this.http.post<{ ok: boolean; updated: number }>(
      '/api/notifications',
      this.withActorBody({ op: 'markReadBatch', ids })
    );
  }

  markAllRead(): Observable<{ ok: boolean; updated: number }> {
    return this.http.post<{ ok: boolean; updated: number }>(
      '/api/notifications',
      this.withActorBody({ op: 'markAllRead' })
    );
  }

  private normalizeLimit(value: number, fallback: number): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(250, Math.max(1, Math.floor(parsed)));
  }

  private withActorParams(params: HttpParams): HttpParams {
    const user = this.auth.user();
    if (!user) return params;
    let next = params;
    if (user.id) next = next.set('userId', user.id);
    if (user.email) next = next.set('userEmail', user.email);
    if (user.displayName) next = next.set('userName', user.displayName);
    return next;
  }

  private withActorBody<T extends Record<string, unknown>>(body: T): T & {
    actorUserId?: string;
    actorEmail?: string;
    actorDisplayName?: string;
  } {
    const user = this.auth.user();
    if (!user) return body;
    return {
      ...body,
      actorUserId: user.id || undefined,
      actorEmail: user.email || undefined,
      actorDisplayName: user.displayName || undefined
    };
  }
}
