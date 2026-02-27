import { Component, HostListener, OnDestroy, OnInit, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { IonButton, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  barChartOutline,
  calendarClearOutline,
  chatbubbleEllipsesOutline,
  chevronBackOutline,
  chevronForwardOutline,
  cubeOutline,
  gridOutline,
  peopleOutline,
  receiptOutline
} from 'ionicons/icons';
import { BrandSettingsService } from '../../services/brand-settings.service';
import { ShellFooterComponent } from '../../components/layout/shell-footer/shell-footer.component';
import { SmsApiService, SmsMessage } from '../../services/sms-api.service';
import { UserScopedSettingsService } from '../../services/user-scoped-settings.service';
import { AuthService } from '../../auth/auth.service';
import { environment } from '../../../environments/environment';

const NAV_COLLAPSED_SETTING_KEY = 'ui.navCollapsed';

type MessageThread = {
  key: string;
  customerId: string | null;
  name: string;
  initials: string;
  unread: number;
  preview: string;
  color: string;
  latestAt: string;
  messageIds: string[];
};

@Component({
  selector: 'app-internal-shell',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    IonButton,
    IonIcon,
    ShellFooterComponent
  ],
  templateUrl: './internal-shell.component.html',
  styleUrls: ['./internal-shell.component.scss']
})
export class InternalShellComponent implements OnInit, OnDestroy {
  private readonly dayMs = 24 * 60 * 60 * 1000;
  private readonly hubThreadLimit = 6;
  private readonly mobileBreakpoint = 900;
  private readonly isLocalHost = typeof window !== 'undefined'
    && ['localhost', '127.0.0.1'].includes(window.location.hostname);
  readonly branding = inject(BrandSettingsService);
  private readonly smsApi = inject(SmsApiService);
  private readonly userSettings = inject(UserScopedSettingsService);
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly collapsed = signal(false);
  readonly isMobile = signal(false);
  readonly smsLoading = signal(false);
  readonly smsError = signal('');
  readonly unreadMessages = signal<SmsMessage[]>([]);
  readonly messageThreads = computed(() => this.buildThreads(this.unreadMessages()));
  readonly visibleMessageThreads = computed(() => this.messageThreads().slice(0, this.hubThreadLimit));
  readonly hasMoreMessageThreads = computed(() => this.messageThreads().length > this.hubThreadLimit);
  readonly nowMs = signal(Date.now());
  readonly trialEndsAtMs = computed(() => {
    const parsed = Date.parse(this.auth.trialEndsAt());
    return Number.isFinite(parsed) ? parsed : null;
  });
  readonly showTrialBanner = computed(() => {
    if (!this.auth.isAuthenticated()) return false;
    if (environment.auth.devBypass) return false;
    if (this.isLocalHost) return false;
    return this.auth.billingStatus() === 'trial';
  });
  readonly trialDaysLeft = computed(() => {
    this.nowMs();
    const trialEndsAt = this.trialEndsAtMs();
    if (trialEndsAt == null) return null;
    const remaining = trialEndsAt - this.nowMs();
    if (remaining <= 0) return 0;
    return Math.max(1, Math.ceil(remaining / this.dayMs));
  });
  readonly trialCountdownLabel = computed(() => {
    const days = this.trialDaysLeft();
    if (days == null) return 'Trial active';
    if (days <= 0) return 'Trial ends today';
    if (days === 1) return '1 day left';
    return `${days} days left`;
  });
  private hasLoadedInbox = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private navLoadToken = 0;

  constructor() {
    addIcons({
      'grid-outline': gridOutline,
      'calendar-clear-outline': calendarClearOutline,
      'cube-outline': cubeOutline,
      'people-outline': peopleOutline,
      'receipt-outline': receiptOutline,
      'bar-chart-outline': barChartOutline,
      'chevron-back-outline': chevronBackOutline,
      'chevron-forward-outline': chevronForwardOutline,
      'chatbubble-ellipses-outline': chatbubbleEllipsesOutline
    });

    effect(() => {
      this.userSettings.scope();
      this.loadCollapsedPreference();
    });
  }

  ngOnInit(): void {
    this.updateMobileState();
    this.refreshSmsInbox(false);
    this.refreshTimer = setInterval(() => this.refreshSmsInbox(true), 5000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  toggleCollapsed(): void {
    const next = !this.collapsed();
    this.collapsed.set(next);
    this.userSettings.setValue(NAV_COLLAPSED_SETTING_KEY, next).subscribe({ error: () => {} });
  }

  @HostListener('window:resize')
  onResize(): void {
    this.updateMobileState();
  }

  handleMessagesPanelClick(event: Event): void {
    if (!this.isMobile()) return;
    event.preventDefault();
    this.openMessagesScreen();
  }

  private refreshSmsInbox(background: boolean): void {
    this.nowMs.set(Date.now());
    if (!background && !this.hasLoadedInbox) {
      this.smsLoading.set(true);
      this.smsError.set('');
    }
    this.smsApi.listInbox().subscribe({
      next: res => {
        this.unreadMessages.set(Array.isArray(res.items) ? res.items : []);
        this.smsError.set('');
        this.smsLoading.set(false);
        this.hasLoadedInbox = true;
      },
      error: () => {
        if (!background || !this.unreadMessages().length) {
          this.smsError.set('SMS inbox unavailable.');
        }
        this.smsLoading.set(false);
        this.hasLoadedInbox = true;
      }
    });
  }

  openThread(thread: MessageThread): void {
    if (!thread.messageIds.length) return;
    const targetIds = new Set(thread.messageIds);
    this.unreadMessages.update(list => list.filter(item => !targetIds.has(item.id)));

    this.smsApi.markReadBatch(thread.messageIds).subscribe({
      error: () => this.refreshSmsInbox(true)
    });

    if (this.isMobile()) {
      this.openMessagesScreen();
      return;
    }

    if (thread.customerId) {
      this.router.navigate(['/customers', thread.customerId], { queryParams: { tab: 'sms' } });
    }
  }

  relativeTimeLabel(iso: string): string {
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return '';
    const deltaMs = Date.now() - ts;
    const mins = Math.max(1, Math.floor(deltaMs / 60000));
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  trackThread(_index: number, thread: MessageThread): string {
    return thread.key;
  }

  openMessagesScreen(): void {
    this.router.navigate(['/messages']);
  }

  openBilling(): void {
    this.router.navigate(['/billing'], {
      queryParams: { redirect: this.router.url || '/dashboard' }
    });
  }

  private loadCollapsedPreference(): void {
    const token = ++this.navLoadToken;
    this.userSettings.getValue<boolean>(NAV_COLLAPSED_SETTING_KEY).subscribe(value => {
      if (token !== this.navLoadToken) return;
      this.collapsed.set(value === true);
    });
  }

  private updateMobileState(): void {
    if (typeof window === 'undefined') return;
    this.isMobile.set(window.innerWidth <= this.mobileBreakpoint);
  }

  private buildThreads(messages: SmsMessage[]): MessageThread[] {
    const map = new Map<string, MessageThread>();
    for (const item of messages) {
      const key = item.customerId || item.from || item.id;
      const existing = map.get(key);
      const fallbackName = item.customerId ? 'Unknown customer' : 'Unknown sender';
      const name = (item.customerName || item.from || fallbackName).trim();
      if (!existing) {
        map.set(key, {
          key,
          customerId: item.customerId,
          name,
          initials: this.initialsFor(name),
          unread: 1,
          preview: item.message,
          color: this.colorForSeed(key),
          latestAt: item.createdAt,
          messageIds: [item.id]
        });
        continue;
      }

      existing.unread += 1;
      existing.messageIds.push(item.id);
      const currentTs = Date.parse(existing.latestAt);
      const nextTs = Date.parse(item.createdAt);
      if (!Number.isFinite(currentTs) || (Number.isFinite(nextTs) && nextTs > currentTs)) {
        existing.latestAt = item.createdAt;
        existing.preview = item.message;
      }
    }

    const threads = Array.from(map.values());
    threads.sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt));
    return threads;
  }

  private initialsFor(name: string): string {
    const parts = (name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return 'SMS';
    const first = parts[0].charAt(0);
    const second = parts.length > 1 ? parts[1].charAt(0) : parts[0].charAt(1);
    const value = `${first}${second || ''}`.trim();
    return (value || 'SMS').toUpperCase();
  }

  private colorForSeed(seed: string): string {
    const palette = ['#1d4ed8', '#0f766e', '#b45309', '#be185d', '#4c1d95', '#0f766e', '#374151'];
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(i);
      hash |= 0;
    }
    const index = Math.abs(hash) % palette.length;
    return palette[index];
  }
}
