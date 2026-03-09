import { Component, OnDestroy, OnInit, computed, effect, inject, signal } from '@angular/core';
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
import { forkJoin } from 'rxjs';
import { environment } from '../../../../environments/environment';

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

  readonly menuOpen = signal(false);
  readonly menuEvent = signal<Event | null>(null);
  readonly avatarLoadError = signal(false);
  readonly notificationsOpen = signal(false);
  readonly notificationsEvent = signal<Event | null>(null);
  readonly notificationsLoading = signal(false);
  readonly notificationsError = signal('');
  readonly notificationItems = signal<AppNotification[]>([]);
  readonly demoToolsEnabled = !!environment.features?.demoTools;
  readonly notificationsTotal = signal(0);
  readonly unreadNotifications = signal(0);
  readonly showAllNotifications = signal(false);
  readonly notificationsDrawerOpen = signal(false);
  readonly seedingNotifications = signal(false);
  readonly visibleNotifications = computed(() =>
    this.showAllNotifications() ? this.notificationItems() : this.notificationItems().slice(0, this.recentLimit)
  );
  readonly hasMoreNotifications = computed(() => this.notificationsTotal() > this.recentLimit);
  readonly unreadBadgeText = computed(() => {
    const count = this.unreadNotifications();
    if (count > 99) return '99+';
    return String(count);
  });
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly recentLimit = 3;

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
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
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
    if (next) {
      this.notificationsEvent.set(event);
    }
    this.notificationsOpen.set(next);
    if (!next) {
      this.showAllNotifications.set(false);
      this.notificationsDrawerOpen.set(false);
      return;
    }

    if (this.showAllNotifications()) {
      this.loadAllNotifications(false);
      return;
    }
    this.loadRecentNotifications(false);
  }

  closeNotifications(): void {
    this.notificationsOpen.set(false);
    this.showAllNotifications.set(false);
    this.notificationsDrawerOpen.set(false);
  }

  viewAllNotifications(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.notificationsOpen.set(false);
    this.notificationsDrawerOpen.set(true);
    this.showAllNotifications.set(true);
    this.loadAllNotifications(false);
  }

  closeNotificationsDrawer(): void {
    this.notificationsDrawerOpen.set(false);
    this.showAllNotifications.set(false);
  }

  showRecentNotifications(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.showAllNotifications.set(false);
    this.loadRecentNotifications(false);
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
      },
      error: () => {
        this.notificationsError.set('Could not mark notifications as read.');
      }
    });
  }

  seedDemoNotifications(event: Event): void {
    if (!this.demoToolsEnabled) return;
    event.preventDefault();
    event.stopPropagation();

    const user = this.user();
    if (!user || (!user.id && !user.email)) {
      this.notificationsError.set('Could not identify the current user for demo notifications.');
      return;
    }

    this.notificationsError.set('');
    this.seedingNotifications.set(true);

    const targetPayload = {
      targetUserId: user.id || undefined,
      targetEmail: user.email || undefined,
      targetDisplayName: user.displayName || user.email || 'You'
    };

    const samples: Array<{
      title: string;
      message: string;
      route: string;
      entityType: string;
      entityId: string;
      metadata: Record<string, unknown>;
    }> = [
      {
        title: 'New SMS received',
        message: 'A customer sent a new message and is waiting for a reply.',
        route: '/messages',
        entityType: 'sms',
        entityId: `sms-${Date.now()}`,
        metadata: { channel: 'sms', severity: 'high' }
      },
      {
        title: 'Invoice needs approval',
        message: 'Draft invoice INV-430501 is ready for review.',
        route: '/quotes-invoices',
        entityType: 'invoice',
        entityId: 'inv-430501',
        metadata: { lane: 'draft', action: 'review' }
      },
      {
        title: 'Customer profile updated',
        message: 'A customer profile was updated with new vehicle details.',
        route: '/customers',
        entityType: 'customer',
        entityId: 'customer-update',
        metadata: { source: 'profile', action: 'view' }
      },
      {
        title: 'Weekly report is ready',
        message: 'Your weekly operations report is available to review.',
        route: '/reports',
        entityType: 'report',
        entityId: 'ops-weekly',
        metadata: { period: 'weekly', action: 'open' }
      }
    ];

    forkJoin(
      samples.map(sample =>
        this.notificationsApi.createMention({
          ...targetPayload,
          ...sample
        })
      )
    ).subscribe({
      next: () => {
        this.seedingNotifications.set(false);
        if (this.showAllNotifications()) {
          this.loadAllNotifications(false);
          return;
        }
        this.loadRecentNotifications(false);
      },
      error: () => {
        this.seedingNotifications.set(false);
        this.notificationsError.set('Could not generate demo notifications.');
      }
    });
  }

  openNotification(notification: AppNotification, event: Event): void {
    event.preventDefault();
    event.stopPropagation();

    const targetRoute = this.resolveNotificationRoute(notification);
    const navigate = () => {
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
        this.unreadNotifications.set(Math.max(0, this.unreadNotifications() - 1));
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
    if ((this.notificationsOpen() || this.notificationsDrawerOpen()) && this.showAllNotifications()) {
      this.loadAllNotifications(background);
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

  private loadAllNotifications(background: boolean): void {
    if (!background) {
      this.notificationsLoading.set(true);
      this.notificationsError.set('');
    }

    this.notificationsApi.listAll(200).subscribe({
      next: res => {
        this.notificationItems.set(Array.isArray(res.items) ? res.items : []);
        const unreadFromItems = this.notificationItems().filter(item => !item.read).length;
        const unread = Number.isFinite(res.unreadCount) ? Number(res.unreadCount) : unreadFromItems;
        this.notificationsTotal.set(Number.isFinite(res.total) ? Number(res.total) : this.notificationItems().length);
        this.unreadNotifications.set(Math.max(0, unread));
        this.notificationsLoading.set(false);
      },
      error: () => {
        if (!background) {
          this.notificationsError.set('Could not load notifications.');
          this.notificationsLoading.set(false);
        }
      }
    });
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
        return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
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
}
