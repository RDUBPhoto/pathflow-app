import { Component, OnDestroy, OnInit, ViewChild, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  IonAvatar,
  IonButton,
  IonContent,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonPopover,
  IonToggle
} from '@ionic/angular/standalone';
import { Router, RouterLink } from '@angular/router';
import { addIcons } from 'ionicons';
import {
  chevronDownOutline,
  checkmarkDoneOutline,
  closeOutline,
  logOutOutline,
  notificationsOutline,
  openOutline,
  personCircleOutline,
  shieldCheckmarkOutline
} from 'ionicons/icons';
import { AuthService } from '../../../auth/auth.service';
import { AppNotification, NotificationsApiService } from '../../../services/notifications-api.service';
import { ThemeService } from '../../../services/theme.service';

const NOTIFICATION_OPENED_HINTS_KEY = 'pathflow.notifications.opened.v1';
const NOTIFICATION_ACK_STATE_KEY = 'pathflow.notifications.ack.v1';

@Component({
  selector: 'app-user-menu',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    IonButton,
    IonAvatar,
    IonIcon,
    IonPopover,
    IonContent,
    IonList,
    IonItem,
    IonLabel,
    IonToggle
  ],
  templateUrl: './user-menu.component.html',
  styleUrls: ['./user-menu.component.scss']
})
export class UserMenuComponent implements OnInit, OnDestroy {
  readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);
  private readonly router = inject(Router);
  private readonly notificationsApi = inject(NotificationsApiService);
  @ViewChild('notificationsPopover') private notificationsPopover?: IonPopover;

  readonly menuOpen = signal(false);
  readonly menuEvent = signal<Event | null>(null);
  readonly avatarLoadError = signal(false);
  readonly notificationsOpen = signal(false);
  readonly notificationsLoading = signal(false);
  readonly notificationsError = signal('');
  readonly notificationItems = signal<AppNotification[]>([]);
  readonly notificationsTotal = signal(0);
  readonly unreadNotifications = signal(0);
  readonly unreadCounterAcknowledged = signal(false);
  readonly showAllNotifications = signal(false);
  readonly loadingMoreNotifications = signal(false);
  readonly hasMoreAllNotifications = signal(false);
  readonly visibleNotifications = computed(() =>
    this.showAllNotifications() ? this.notificationItems() : this.notificationItems().slice(0, this.recentLimit)
  );
  readonly hasMoreNotifications = computed(() => this.notificationsTotal() > this.recentLimit);
  readonly unreadBadgeText = computed(() => {
    const count = this.unreadNotifications();
    if (count > 99) return '99+';
    return String(count);
  });
  readonly showUnreadCounter = computed(() =>
    this.unreadNotifications() > 0 && !this.unreadCounterAcknowledged()
  );
  readonly notificationAriaLabel = computed(() => {
    const unread = this.unreadNotifications();
    if (unread > 0) {
      return `Open notifications (${this.unreadBadgeText()} unread)`;
    }
    return 'Open notifications';
  });
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly recentLimit = 3;
  private readonly allPageSize = 50;
  private allOffset = 0;
  private acknowledgedUnreadIds = new Set<string>();
  private acknowledgedUnreadCount = 0;
  private readonly handleNotificationsRefresh = () => {
    this.refreshNotifications(false);
  };

  private readonly avatarPalette = [
    '#0f766e',
    '#1d4ed8',
    '#7c3aed',
    '#be185d',
    '#b45309',
    '#0f172a',
    '#334155',
    '#166534',
    '#9f1239'
  ];

  readonly user = computed(() => this.auth.user());
  readonly userDisplayName = computed(() => {
    const user = this.user();
    return (user?.displayName || user?.email || 'User').trim();
  });
  readonly isDarkTheme = computed(() => this.theme.mode() === 'dark');
  readonly userEmail = computed(() => (this.user()?.email || '').trim());
  readonly firstName = computed(() => this.extractFirstName(this.userDisplayName(), this.userEmail()));
  readonly initials = computed(() => this.extractInitials(this.userDisplayName(), this.userEmail()));
  readonly avatarUrl = computed(() => (this.user()?.avatarUrl || '').trim());
  readonly showAvatarImage = computed(() => !!this.avatarUrl() && !this.avatarLoadError());
  readonly avatarColor = computed(() => {
    const user = this.user();
    const seed = (user?.id || user?.email || user?.displayName || 'user').trim().toLowerCase();
    return this.pickColor(seed);
  });
  private lastAvatarUrl = '';

  constructor() {
    addIcons({
      'chevron-down-outline': chevronDownOutline,
      'person-circle-outline': personCircleOutline,
      'shield-checkmark-outline': shieldCheckmarkOutline,
      'log-out-outline': logOutOutline,
      'notifications-outline': notificationsOutline,
      'close-outline': closeOutline,
      'checkmark-done-outline': checkmarkDoneOutline,
      'open-outline': openOutline
    });

    effect(() => {
      const currentUrl = this.avatarUrl();
      if (currentUrl !== this.lastAvatarUrl) {
        this.lastAvatarUrl = currentUrl;
        this.avatarLoadError.set(false);
      }
    });
  }

  ngOnInit(): void {
    this.refreshNotifications(false);
    this.refreshTimer = setInterval(() => this.refreshNotifications(true), 15000);
    if (typeof window !== 'undefined') {
      window.addEventListener('pathflow:notifications-refresh', this.handleNotificationsRefresh);
    }
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('pathflow:notifications-refresh', this.handleNotificationsRefresh);
    }
  }

  openMenu(event: Event): void {
    this.notificationsOpen.set(false);
    this.menuEvent.set(event);
    this.menuOpen.set(true);
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }

  toggleNotifications(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.closeMenu();

    const next = !this.notificationsOpen();
    this.notificationsOpen.set(next);
    if (!next) {
      this.showAllNotifications.set(false);
      return;
    }
    this.acknowledgeCurrentUnread();

    if (this.showAllNotifications()) {
      this.loadAllNotifications(false);
      return;
    }
    this.loadRecentNotifications(false);
  }

  closeNotifications(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.notificationsPopover?.dismiss();
    this.notificationsOpen.set(false);
    this.showAllNotifications.set(false);
    this.allOffset = 0;
    this.loadingMoreNotifications.set(false);
    this.hasMoreAllNotifications.set(false);
  }

  onNotificationsPopoverDismiss(): void {
    this.notificationsOpen.set(false);
    this.showAllNotifications.set(false);
    this.allOffset = 0;
    this.loadingMoreNotifications.set(false);
    this.hasMoreAllNotifications.set(false);
  }

  viewAllNotifications(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.showAllNotifications.set(true);
    this.allOffset = 0;
    this.loadAllNotifications(false, false);
  }

  showRecentNotifications(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.showAllNotifications.set(false);
    this.allOffset = 0;
    this.loadingMoreNotifications.set(false);
    this.hasMoreAllNotifications.set(false);
    this.loadRecentNotifications(false);
  }

  loadMoreNotifications(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.loadingMoreNotifications() || !this.hasMoreAllNotifications()) return;
    this.loadAllNotifications(false, true);
  }

  markAllNotificationsRead(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.notificationsApi.markAllRead().subscribe({
      next: () => {
        this.notificationItems.update(items =>
          items.map(item => ({ ...item, read: true, readAt: item.readAt || new Date().toISOString() }))
        );
        this.unreadNotifications.set(0);
        this.syncUnreadCounterState(this.notificationItems(), 0);
      },
      error: () => {
        this.notificationsError.set('Could not mark notifications as read.');
      }
    });
  }

  openNotification(notification: AppNotification, event: Event): void {
    event.preventDefault();
    event.stopPropagation();

    const targetRoute = this.resolveNotificationRoute(notification);
    const navigate = () => {
      this.rememberOpenedNotification(notification);
      this.router.navigateByUrl(targetRoute);
      this.closeNotifications();
    };

    if (notification.read) {
      navigate();
      return;
    }

    this.notificationsApi.markRead(notification.id).subscribe({
      next: () => {
        this.notificationItems.update(items =>
          items.map(item => (item.id === notification.id ? { ...item, read: true, readAt: new Date().toISOString() } : item))
        );
        const nextUnread = Math.max(0, this.unreadNotifications() - 1);
        this.unreadNotifications.set(nextUnread);
        this.syncUnreadCounterState(this.notificationItems(), nextUnread);
        navigate();
      },
      error: () => {
        this.notificationsError.set('Could not open notification right now.');
        navigate();
      }
    });
  }

  notificationTimeLabel(iso: string): string {
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return '';
    const deltaMs = Date.now() - ts;
    const mins = Math.max(1, Math.floor(deltaMs / 60000));
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  isNotificationUnread(notification: AppNotification): boolean {
    if (!notification || notification.read) return false;
    if (!this.unreadCounterAcknowledged()) return true;
    const id = String(notification.id || '').trim();
    if (!id) return false;
    return !this.acknowledgedUnreadIds.has(id);
  }

  onAvatarError(): void {
    this.avatarLoadError.set(true);
  }

  signOut(): void {
    this.closeMenu();
    this.auth.signOut('/login');
  }

  onThemeToggle(checked: boolean): void {
    this.theme.setMode(checked ? 'dark' : 'light');
  }

  private refreshNotifications(background: boolean): void {
    if (this.notificationsOpen() && this.showAllNotifications()) {
      this.allOffset = 0;
      this.loadAllNotifications(background, false);
      return;
    }
    this.loadRecentNotifications(background);
  }

  private loadRecentNotifications(background: boolean): void {
    if (!background) {
      this.notificationsLoading.set(true);
      this.notificationsError.set('');
    }

    this.notificationsApi.listRecent(this.recentLimit).subscribe({
      next: res => {
        this.notificationItems.set(Array.isArray(res.items) ? res.items : []);
        const unreadFromItems = this.notificationItems().filter(item => !item.read).length;
        const unread = Number.isFinite(res.unreadCount) ? Number(res.unreadCount) : unreadFromItems;
        this.notificationsTotal.set(Number.isFinite(res.total) ? Number(res.total) : this.notificationItems().length);
        this.unreadNotifications.set(Math.max(0, unread));
        this.syncUnreadCounterState(this.notificationItems(), Math.max(0, unread));
        this.hasMoreAllNotifications.set(false);
        this.loadingMoreNotifications.set(false);
        this.notificationsLoading.set(false);
      },
      error: () => {
        if (!background) {
          this.notificationsError.set('Notifications unavailable.');
          this.notificationsLoading.set(false);
        }
      }
    });
  }

  private loadAllNotifications(background: boolean, append = false): void {
    if (!background && !append) {
      this.notificationsLoading.set(true);
      this.notificationsError.set('');
    }
    if (append) {
      this.loadingMoreNotifications.set(true);
      this.notificationsError.set('');
    }

    this.notificationsApi.listAll(this.allPageSize, this.allOffset).subscribe({
      next: res => {
        const incoming = Array.isArray(res.items) ? res.items : [];
        const nextItems = append
          ? this.mergeNotifications(this.notificationItems(), incoming)
          : incoming;
        this.notificationItems.set(nextItems);
        const responseOffset = Number.isFinite(res.offset) ? Number(res.offset) : this.allOffset;
        const responseLimit = Number.isFinite(res.limit) && Number(res.limit) > 0
          ? Number(res.limit)
          : this.allPageSize;
        this.allOffset = responseOffset + incoming.length;
        const unreadFromItems = this.notificationItems().filter(item => !item.read).length;
        const unread = Number.isFinite(res.unreadCount) ? Number(res.unreadCount) : unreadFromItems;
        this.notificationsTotal.set(Number.isFinite(res.total) ? Number(res.total) : this.notificationItems().length);
        this.unreadNotifications.set(Math.max(0, unread));
        this.syncUnreadCounterState(this.notificationItems(), Math.max(0, unread));
        const hasMore = typeof res.hasMore === 'boolean'
          ? res.hasMore
          : this.allOffset < this.notificationsTotal();
        this.hasMoreAllNotifications.set(hasMore && incoming.length >= Math.min(this.allPageSize, responseLimit));
        this.loadingMoreNotifications.set(false);
        this.notificationsLoading.set(false);
      },
      error: () => {
        if (append) {
          this.loadingMoreNotifications.set(false);
          this.notificationsError.set('Could not load more notifications.');
          return;
        }
        if (!background) {
          this.notificationsError.set('Could not load notifications.');
          this.notificationsLoading.set(false);
        }
      }
    });
  }

  private mergeNotifications(existing: AppNotification[], incoming: AppNotification[]): AppNotification[] {
    if (!existing.length) return incoming;
    if (!incoming.length) return existing;
    const byId = new Map<string, AppNotification>();
    for (const item of existing) {
      byId.set(String(item.id || '').trim(), item);
    }
    for (const item of incoming) {
      byId.set(String(item.id || '').trim(), item);
    }
    return [...byId.values()].sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
  }

  private normalizeRoute(value: string): string {
    const route = (value || '').trim();
    if (!route) return '/dashboard';
    return route.startsWith('/') ? route : `/${route}`;
  }

  private resolveNotificationRoute(notification: AppNotification): string {
    const entityRoute = this.resolveEntityRoute(notification);
    if (entityRoute) return entityRoute;

    const routeDerived = this.resolveRouteDerivedTarget(notification.route);
    if (routeDerived) return routeDerived;

    return this.normalizeRoute(notification.route);
  }

  private resolveEntityRoute(notification: AppNotification): string | null {
    const entityType = String(notification.entityType || '').trim().toLowerCase();
    const metadata = this.asRecord(notification.metadata);

    const quoteIdentifier = this.firstNonEmpty([
      entityType === 'quote' ? notification.entityId : null,
      this.readMetadataString(metadata, 'quoteId'),
      this.readMetadataString(metadata, 'quoteNumber'),
      this.readRouteQueryParam(notification.route, 'quoteId'),
      this.readRouteQueryParam(notification.route, 'quoteNumber'),
    ]);
    if (quoteIdentifier) {
      return `/quotes/${encodeURIComponent(quoteIdentifier)}`;
    }

    const invoiceId = this.firstNonEmpty([
      entityType === 'invoice' ? notification.entityId : null,
      this.readMetadataString(metadata, 'invoiceId'),
      this.readRouteQueryParam(notification.route, 'invoiceId')
    ]);
    if (invoiceId) {
      return `/invoices/${encodeURIComponent(invoiceId)}`;
    }

    const customerId = this.firstNonEmpty([
      entityType === 'customer' ? notification.entityId : null,
      this.readMetadataString(metadata, 'customerId'),
      this.readRouteQueryParam(notification.route, 'customerId')
    ]);
    if (customerId) {
      if (entityType === 'sms' || entityType === 'message' || entityType === 'messages') {
        return `/customers/${encodeURIComponent(customerId)}?tab=sms`;
      }
      if (entityType === 'email') {
        return `/customers/${encodeURIComponent(customerId)}?tab=email`;
      }
      return `/customers/${encodeURIComponent(customerId)}`;
    }

    return null;
  }

  private resolveRouteDerivedTarget(route: string): string | null {
    const normalized = this.normalizeRoute(route);

    const quoteIdentifier = this.firstNonEmpty([
      this.readRouteQueryParam(normalized, 'quoteId'),
      this.readRouteQueryParam(normalized, 'quoteNumber')
    ]);
    if (quoteIdentifier) {
      return `/quotes/${encodeURIComponent(quoteIdentifier)}`;
    }

    const invoiceId = this.readRouteQueryParam(normalized, 'invoiceId');
    if (invoiceId) {
      return `/invoices/${encodeURIComponent(invoiceId)}`;
    }

    const customerId = this.readRouteQueryParam(normalized, 'customerId');
    if (customerId) {
      if (normalized.startsWith('/messages')) {
        return `/customers/${encodeURIComponent(customerId)}?tab=sms`;
      }
      if (normalized.startsWith('/customers')) {
        return `/customers/${encodeURIComponent(customerId)}`;
      }
    }

    return null;
  }

  private readRouteQueryParam(route: string, key: string): string {
    const value = String(route || '').trim();
    if (!value) return '';
    const queryIndex = value.indexOf('?');
    if (queryIndex < 0) return '';
    const query = value.slice(queryIndex + 1);
    const params = new URLSearchParams(query);
    return (params.get(key) || '').trim();
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object') return value as Record<string, unknown>;
    return {};
  }

  private readMetadataString(metadata: Record<string, unknown>, key: string): string {
    return String(metadata[key] ?? '').trim();
  }

  private firstNonEmpty(values: Array<unknown>): string {
    for (const candidate of values) {
      const text = String(candidate ?? '').trim();
      if (text) return text;
    }
    return '';
  }

  private extractFirstName(displayName: string, email: string): string {
    const cleanName = displayName.trim();
    if (cleanName) {
      const parts = cleanName.split(/\s+/).filter(Boolean);
      if (parts.length) return parts[0];
    }

    const emailLocal = (email.split('@')[0] || '').trim();
    const tokens = emailLocal.split(/[._-]+/).filter(Boolean);
    if (tokens.length) return this.capitalize(tokens[0]);

    return 'User';
  }

  private extractInitials(displayName: string, email: string): string {
    const cleanName = displayName.trim();
    if (cleanName) {
      const words = cleanName.split(/\s+/).filter(Boolean);
      if (words.length >= 2) {
        return `${words[0][0]}${words[1][0]}`.toUpperCase();
      }

      const single = words[0] || '';
      if (single.length >= 2) return single.slice(0, 2).toUpperCase();
      if (single.length === 1) return `${single[0]}${single[0]}`.toUpperCase();
    }

    const local = (email.split('@')[0] || '').trim();
    const tokens = local.split(/[._-]+/).filter(Boolean);
    if (tokens.length >= 2) {
      return `${tokens[0][0]}${tokens[1][0]}`.toUpperCase();
    }

    if (local.length >= 2) return local.slice(0, 2).toUpperCase();
    if (local.length === 1) return `${local[0]}${local[0]}`.toUpperCase();
    return 'US';
  }

  private capitalize(value: string): string {
    if (!value) return value;
    return value[0].toUpperCase() + value.slice(1);
  }

  private pickColor(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    }

    const index = Math.abs(hash) % this.avatarPalette.length;
    return this.avatarPalette[index];
  }

  private rememberOpenedNotification(notification: AppNotification): void {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(NOTIFICATION_OPENED_HINTS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      const existing = Array.isArray(list) ? list : [];
      const next = [
        ...existing,
        {
          id: String(notification.id || '').trim(),
          entityType: String(notification.entityType || '').trim().toLowerCase(),
          entityId: String(notification.entityId || '').trim(),
          metadata: (notification.metadata && typeof notification.metadata === 'object')
            ? notification.metadata
            : {},
          openedAt: new Date().toISOString()
        }
      ];
      localStorage.setItem(
        NOTIFICATION_OPENED_HINTS_KEY,
        JSON.stringify(next.slice(-100))
      );
    } catch {
      // Ignore local storage failures.
    }
  }

  private acknowledgeCurrentUnread(): void {
    const unreadCount = Math.max(0, this.unreadNotifications());
    const unreadIds = this.notificationItems()
      .filter(item => !item.read)
      .map(item => String(item.id || '').trim())
      .filter(Boolean);
    this.acknowledgedUnreadCount = unreadCount;
    this.acknowledgedUnreadIds = unreadIds.length ? new Set(unreadIds) : new Set<string>();
    if (unreadCount > 0) {
      this.unreadCounterAcknowledged.set(true);
      this.writeAcknowledgementState(unreadCount, unreadIds);
      return;
    }
    this.unreadCounterAcknowledged.set(false);
    this.clearAcknowledgementState();
  }

  private syncUnreadCounterState(items: AppNotification[], unreadCount: number): void {
    if (!Number.isFinite(unreadCount) || unreadCount <= 0) {
      this.unreadCounterAcknowledged.set(false);
      this.acknowledgedUnreadIds = new Set<string>();
      this.acknowledgedUnreadCount = 0;
      this.clearAcknowledgementState();
      return;
    }

    const unreadIds = (Array.isArray(items) ? items : [])
      .filter(item => !item.read)
      .map(item => String(item.id || '').trim())
      .filter(Boolean);

    if (!this.unreadCounterAcknowledged()) {
      const stored = this.readAcknowledgementState();
      if (stored && unreadCount <= stored.count) {
        if (!unreadIds.length) {
          this.unreadCounterAcknowledged.set(true);
          this.acknowledgedUnreadCount = stored.count;
          this.acknowledgedUnreadIds = new Set<string>();
          return;
        }
        const storedIds = new Set(stored.ids);
        const allUnreadAlreadyAcknowledged = unreadIds.every(id => storedIds.has(id));
        if (allUnreadAlreadyAcknowledged) {
          this.unreadCounterAcknowledged.set(true);
          this.acknowledgedUnreadCount = stored.count;
          this.acknowledgedUnreadIds = new Set(unreadIds);
          return;
        }
      }
      this.acknowledgedUnreadIds = unreadIds.length ? new Set(unreadIds) : new Set<string>();
      return;
    }

    if (!unreadIds.length) {
      if (unreadCount > this.acknowledgedUnreadCount) {
        this.unreadCounterAcknowledged.set(false);
        this.clearAcknowledgementState();
      }
      return;
    }

    // If we acknowledged by count before IDs were loaded, adopt current IDs
    // while unread count has not increased.
    if (!this.acknowledgedUnreadIds.size) {
      if (unreadCount <= this.acknowledgedUnreadCount) {
        this.acknowledgedUnreadIds = new Set(unreadIds);
        this.acknowledgedUnreadCount = unreadCount;
        this.writeAcknowledgementState(unreadCount, unreadIds);
        return;
      }
      this.unreadCounterAcknowledged.set(false);
      this.acknowledgedUnreadIds = new Set(unreadIds);
      this.clearAcknowledgementState();
      return;
    }

    const hasNewUnread = unreadIds.some(id => !this.acknowledgedUnreadIds.has(id));
    if (hasNewUnread) {
      this.unreadCounterAcknowledged.set(false);
      this.acknowledgedUnreadIds = new Set(unreadIds);
      this.clearAcknowledgementState();
      return;
    }

    const nextAcknowledged = new Set<string>();
    for (const id of unreadIds) {
      if (this.acknowledgedUnreadIds.has(id)) {
        nextAcknowledged.add(id);
      }
    }
    this.acknowledgedUnreadIds = nextAcknowledged;
    this.acknowledgedUnreadCount = unreadCount;
    this.writeAcknowledgementState(unreadCount, Array.from(nextAcknowledged));
  }

  private notificationAcknowledgementStorageKey(): string {
    const email = String(this.userEmail() || '').trim().toLowerCase();
    if (!email) return '';
    return `${NOTIFICATION_ACK_STATE_KEY}:${email}`;
  }

  private readAcknowledgementState(): { count: number; ids: string[] } | null {
    if (typeof window === 'undefined') return null;
    const key = this.notificationAcknowledgementStorageKey();
    if (!key) return null;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { count?: unknown; ids?: unknown };
      const count = Number(parsed?.count);
      if (!Number.isFinite(count) || count <= 0) return null;
      const ids = Array.isArray(parsed?.ids)
        ? parsed.ids.map(id => String(id || '').trim()).filter(Boolean)
        : [];
      return { count, ids };
    } catch {
      return null;
    }
  }

  private writeAcknowledgementState(count: number, ids: string[]): void {
    if (typeof window === 'undefined') return;
    const key = this.notificationAcknowledgementStorageKey();
    if (!key) return;
    try {
      localStorage.setItem(
        key,
        JSON.stringify({
          count: Math.max(0, count),
          ids: Array.from(new Set((Array.isArray(ids) ? ids : []).map(id => String(id || '').trim()).filter(Boolean)))
        })
      );
    } catch {
      // Ignore local storage failures.
    }
  }

  private clearAcknowledgementState(): void {
    if (typeof window === 'undefined') return;
    const key = this.notificationAcknowledgementStorageKey();
    if (!key) return;
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore local storage failures.
    }
  }
}
