import { HttpClient, HttpParams } from '@angular/common/http';
import { DestroyRef, Injectable, inject } from '@angular/core';
import { finalize, Observable, tap } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { TenantContextService } from './tenant-context.service';

export type NotificationContext = {
  type: 'invoice' | 'quote' | 'customer' | 'lead' | 'workitem' | 'job' | 'email' | 'sms';
  id: string;
  number?: string;
};
export type NotificationOpenedHint = {
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  openedAt: string;
};
const READ_CHANGE_KEY = 'pathflow.notifications.changed.v2';

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
  hasMore: boolean;
  offset: number;
  limit: number;
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
  private readonly tenant = inject(TenantContextService);
  private readonly inFlight = new Set<string>();

  constructor(private readonly http: HttpClient) {
    const changed = (event: StorageEvent) => {
      if (event.key !== READ_CHANGE_KEY || !event.newValue) return;
      try {
        if (JSON.parse(event.newValue).scope === this.readScope()) this.refreshReadState();
      } catch { /* Ignore malformed or unrelated storage events. */ }
    };
    window.addEventListener('storage', changed);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', changed));
  }

  markRelatedRead(contexts: NotificationContext[]): Observable<{ ok: boolean; updated: number; readAt: string }> {
    const scope = this.readScope();
    return this.http.post<{ ok: boolean; updated: number; readAt: string }>('/api/notifications',
      this.withActorBody({ op: 'markRelatedRead', contexts })).pipe(tap(result => {
      if (scope !== this.readScope()) return;
      this.rememberOpened(contexts.map(value => ({ entityType: value.type, entityId: value.id,
        metadata: { [`${value.type}Id`]: value.id, [`${value.type}Number`]: value.number,
          ...(value.type === 'workitem' || value.type === 'lead' ? { leadItemId: value.id } : {}) },
        openedAt: result.readAt })));
      this.broadcastReadChange();
    }));
  }

  acknowledgeView(contexts: NotificationContext[]): void {
    const valid = contexts.filter(value => !!value.id);
    if (!valid.length) return;
    if (valid.length > 20) {
      for (let offset = 0; offset < valid.length; offset += 20) this.acknowledgeView(valid.slice(offset, offset + 20));
      return;
    }
    const key = this.readScope() + JSON.stringify(valid);
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    this.markRelatedRead(valid).pipe(finalize(() => this.inFlight.delete(key))).subscribe({
      error: () => { /* Reading notifications must not prevent opening a record. */ }
    });
  }

  openedHints(): NotificationOpenedHint[] {
    try {
      const hints = JSON.parse(localStorage.getItem(this.openedHintsKey()) || '[]');
      return Array.isArray(hints) ? hints : [];
    } catch { return []; }
  }

  rememberOpened(hints: NotificationOpenedHint[]): void {
    this.saveOpenedHints([...this.openedHints(), ...hints]);
    window.dispatchEvent(new CustomEvent('pathflow:notifications-opened'));
  }

  saveOpenedHints(hints: NotificationOpenedHint[]): void {
    try { localStorage.setItem(this.openedHintsKey(), JSON.stringify(hints.slice(-100))); } catch { /* Storage is optional. */ }
  }

  private openedHintsKey(): string { return 'pathflow.notifications.opened.v2:' + this.readScope(); }
  private readScope(): string { return `${this.tenant.tenantId()}:${this.auth.user()?.email?.toLowerCase() || this.auth.user()?.id || ''}`; }
  private refreshReadState(): void { window.dispatchEvent(new CustomEvent('pathflow:notifications-refresh')); }
  private broadcastReadChange(): void {
    this.refreshReadState();
    try { localStorage.setItem(READ_CHANGE_KEY, JSON.stringify({ scope: this.readScope(), at: Date.now(), nonce: Math.random() })); } catch { /* Storage is optional. */ }
  }

  listRecent(limit = 3): Observable<NotificationsRecentResponse> {
    const params = this.withActorParams(
      new HttpParams()
        .set('scope', 'recent')
        .set('limit', String(this.normalizeLimit(limit, 3)))
    );
    return this.http.get<NotificationsRecentResponse>('/api/notifications', { params });
  }

  listAll(limit = 100, offset = 0): Observable<NotificationsAllResponse> {
    const safeOffset = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
    const params = this.withActorParams(
      new HttpParams()
        .set('scope', 'all')
        .set('limit', String(this.normalizeLimit(limit, 100)))
        .set('offset', String(safeOffset))
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
    ).pipe(tap(() => this.broadcastReadChange()));
  }

  markReadBatch(ids: string[]): Observable<{ ok: boolean; updated: number }> {
    return this.http.post<{ ok: boolean; updated: number }>(
      '/api/notifications',
      this.withActorBody({ op: 'markReadBatch', ids })
    ).pipe(tap(() => this.broadcastReadChange()));
  }

  markAllRead(): Observable<{ ok: boolean; updated: number }> {
    return this.http.post<{ ok: boolean; updated: number }>(
      '/api/notifications',
      this.withActorBody({ op: 'markAllRead' })
    ).pipe(tap(() => this.broadcastReadChange()));
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
