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
import { EmailApiService, EmailMessage } from '../../services/email-api.service';
import { UserScopedSettingsService } from '../../services/user-scoped-settings.service';
import { AuthService } from '../../auth/auth.service';
import { environment } from '../../../environments/environment';

const NAV_COLLAPSED_SETTING_KEY = 'ui.navCollapsed';

type MessageThread = {
  key: string;
  channel: 'sms' | 'email';
  customerId: string | null;
  name: string;
  initials: string;
  unread: number;
  preview: string;
  color: string;
  latestAt: string;
  messageIds: string[];
};

type UnifiedInboxMessage = {
  id: string;
  channel: 'sms' | 'email';
  customerId: string | null;
  customerName: string | null;
  from: string | null;
  message: string;
  createdAt: string;
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
  private readonly emailApi = inject(EmailApiService);
  private readonly userSettings = inject(UserScopedSettingsService);
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly collapsed = signal(false);
  readonly isMobile = signal(false);
  readonly inboxLoading = signal(false);
  readonly inboxError = signal('');
  readonly unreadMessages = signal<UnifiedInboxMessage[]>([]);
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
  readonly showUploadLogoCta = computed(() => {
    if (!this.auth.isAuthenticated()) return false;
    if (!this.auth.isAdmin()) return false;
    if (!this.branding.loaded()) return false;
    return !this.branding.hasCustomLogo();
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
    this.refreshInbox(false);
    this.refreshTimer = setInterval(() => this.refreshInbox(true), 5000);
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

  private refreshInbox(background: boolean): void {
    this.nowMs.set(Date.now());
    if (!background && !this.hasLoadedInbox) {
      this.inboxLoading.set(true);
      this.inboxError.set('');
    }
    this.smsApi.listInbox().subscribe({
      next: smsRes => {
        this.emailApi.listInbox().subscribe({
          next: emailRes => {
            const smsItems = (Array.isArray(smsRes.items) ? smsRes.items : []).map(item => this.toUnifiedSms(item));
            const emailItems = (Array.isArray(emailRes.items) ? emailRes.items : []).map(item => this.toUnifiedEmail(item));
            const merged = [...smsItems, ...emailItems]
              .sort((a, b) => Date.parse(b.createdAt || '') - Date.parse(a.createdAt || ''));
            this.unreadMessages.set(merged);
            this.inboxError.set('');
            this.inboxLoading.set(false);
            this.hasLoadedInbox = true;
          },
          error: () => {
            const smsItems = (Array.isArray(smsRes.items) ? smsRes.items : []).map(item => this.toUnifiedSms(item));
            this.unreadMessages.set(smsItems);
            if (!background || !this.unreadMessages().length) {
              this.inboxError.set('Email inbox unavailable.');
            }
            this.inboxLoading.set(false);
            this.hasLoadedInbox = true;
          }
        });
      },
      error: () => {
        this.emailApi.listInbox().subscribe({
          next: emailRes => {
            const emailItems = (Array.isArray(emailRes.items) ? emailRes.items : []).map(item => this.toUnifiedEmail(item));
            this.unreadMessages.set(emailItems);
            if (!background || !this.unreadMessages().length) {
              this.inboxError.set('SMS inbox unavailable.');
            }
            this.inboxLoading.set(false);
            this.hasLoadedInbox = true;
          },
          error: () => {
            if (!background || !this.unreadMessages().length) {
              this.inboxError.set('Messages inbox unavailable.');
            }
            this.inboxLoading.set(false);
            this.hasLoadedInbox = true;
          }
        });
      }
    });
  }

  openThread(thread: MessageThread): void {
    if (!thread.messageIds.length) return;
    const targetIds = new Set(thread.messageIds);
    this.unreadMessages.update(list => list.filter(item => !(item.channel === thread.channel && targetIds.has(item.id))));

    if (thread.channel === 'sms') {
      this.smsApi.markReadBatch(thread.messageIds).subscribe({
        error: () => this.refreshInbox(true)
      });
    } else {
      this.emailApi.markReadBatch(thread.messageIds).subscribe({
        error: () => this.refreshInbox(true)
      });
    }

    if (this.isMobile()) {
      this.openMessagesScreen(thread.channel);
      return;
    }

    if (thread.customerId) {
      this.router.navigate(['/customers', thread.customerId], { queryParams: { tab: thread.channel } });
      return;
    }
    this.openMessagesScreen(thread.channel);
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

  openMessagesScreen(channel?: 'sms' | 'email'): void {
    if (channel) {
      this.router.navigate(['/messages'], { queryParams: { channel } });
      return;
    }
    this.router.navigate(['/messages']);
  }

  openBilling(): void {
    if (this.auth.isAdmin()) {
      this.router.navigate(['/admin-settings'], { queryParams: { section: 'subscription' } });
      return;
    }
    this.router.navigate(['/billing'], {
      queryParams: { redirect: this.router.url || '/dashboard' }
    });
  }

  openBrandingSettings(): void {
    this.router.navigate(['/admin-settings'], { queryParams: { section: 'branding' } });
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

  private buildThreads(messages: UnifiedInboxMessage[]): MessageThread[] {
    const map = new Map<string, MessageThread>();
    for (const item of messages) {
      const key = `${item.channel}:${item.customerId || item.from || item.id}`;
      const existing = map.get(key);
      const fallbackName = item.customerId ? 'Unknown customer' : 'Unknown sender';
      const name = (item.customerName || item.from || fallbackName).trim();
      const preview = item.channel === 'email'
        ? `Email: ${item.message}`
        : item.message;
      if (!existing) {
        map.set(key, {
          key,
          channel: item.channel,
          customerId: item.customerId,
          name,
          initials: this.initialsFor(name),
          unread: 1,
          preview,
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
        existing.preview = preview;
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

  private toUnifiedSms(item: SmsMessage): UnifiedInboxMessage {
    return {
      id: item.id,
      channel: 'sms',
      customerId: item.customerId || null,
      customerName: item.customerName || null,
      from: item.from || null,
      message: item.message || '',
      createdAt: item.createdAt || new Date().toISOString()
    };
  }

  private toUnifiedEmail(item: EmailMessage): UnifiedInboxMessage {
    const subject = String(item.subject || '').trim();
    const body = String(item.message || '').trim();
    const preview = subject ? `${subject}${body ? ` - ${body}` : ''}` : body;
    return {
      id: item.id,
      channel: 'email',
      customerId: item.customerId || null,
      customerName: item.customerName || null,
      from: item.from || null,
      message: preview || '(no content)',
      createdAt: item.createdAt || new Date().toISOString()
    };
  }
}
