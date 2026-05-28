import { Component, HostListener, OnDestroy, OnInit, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ToastController } from '@ionic/angular';
import { IonButton, IonIcon } from '@ionic/angular/standalone';
import { Subscription, filter, firstValueFrom } from 'rxjs';
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
import { BrandingApi } from '../../services/branding-api.service';
import { ShellFooterComponent } from '../../components/layout/shell-footer/shell-footer.component';
import { SmsApiService, SmsMessage } from '../../services/sms-api.service';
import { EmailApiService, EmailMessage } from '../../services/email-api.service';
import { BusinessProfileService } from '../../services/business-profile.service';
import { AppSettingsApiService } from '../../services/app-settings-api.service';
import { PaymentGatewayProviderKey, PaymentGatewaySettingsService } from '../../services/payment-gateway-settings.service';
import { AccessAdminApiService } from '../../services/access-admin-api.service';
import { UserScopedSettingsService } from '../../services/user-scoped-settings.service';
import { AdminSetupItem, AdminSetupProgressService } from '../../services/admin-setup-progress.service';
import { AuthService } from '../../auth/auth.service';
import { environment } from '../../../environments/environment';

const NAV_COLLAPSED_SETTING_KEY = 'ui.navCollapsed';
const SCHEDULE_SETTINGS_KEY = 'schedule.settings';

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
  private readonly inboxFetchLimit = 200;
  private readonly mobileBreakpoint = 900;
  private readonly isLocalHost = typeof window !== 'undefined'
    && ['localhost', '127.0.0.1'].includes(window.location.hostname);
  readonly branding = inject(BrandSettingsService);
  private readonly brandingApi = inject(BrandingApi);
  private readonly smsApi = inject(SmsApiService);
  private readonly emailApi = inject(EmailApiService);
  private readonly businessProfile = inject(BusinessProfileService);
  private readonly settingsApi = inject(AppSettingsApiService);
  private readonly paymentGatewaySettings = inject(PaymentGatewaySettingsService);
  private readonly accessApi = inject(AccessAdminApiService);
  private readonly toastController = inject(ToastController);
  private readonly userSettings = inject(UserScopedSettingsService);
  readonly auth = inject(AuthService);
  readonly setupProgress = inject(AdminSetupProgressService);
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
  readonly feedbackOpen = signal(false);
  readonly feedbackName = signal('');
  readonly feedbackEmail = signal('');
  readonly feedbackIssue = signal('');
  readonly feedbackStatus = signal('');
  readonly feedbackError = signal('');
  readonly feedbackSending = signal(false);
  private readonly feedbackRecipient = 'robert@pathflow-app.com';
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
  readonly showSetupPrompt = signal(false);
  readonly quickSetupOpen = signal(false);
  readonly quickSetupBusy = signal(false);
  readonly quickSetupError = signal('');
  readonly quickSetupStatus = signal('');
  readonly quickSetupIndex = signal(0);
  readonly quickSetupItems = computed(() => this.setupProgress.pendingItems().length
    ? this.setupProgress.pendingItems()
    : this.setupProgress.items());
  readonly quickSetupCurrent = computed(() => {
    const items = this.quickSetupItems();
    if (!items.length) return null;
    return items[Math.max(0, Math.min(this.quickSetupIndex(), items.length - 1))];
  });

  quickBusinessName = '';
  quickBusinessEmail = '';
  quickBusinessPhone = '';
  quickBusinessAddress = '';
  quickOpenHour = 7;
  quickCloseHour = 16;
  quickPaymentProvider: PaymentGatewayProviderKey = 'authorize-net';
  quickPaymentAccountLabel = '';
  quickPaymentMode: 'test' | 'live' = 'test';
  quickSenderEmail = '';
  quickSenderName = '';
  quickSenderReplyTo = '';
  quickTemplateName = '';
  quickTemplateSubject = '';
  quickTemplateBody = '';
  quickUserName = '';
  quickUserEmail = '';
  quickUserRole: 'admin' | 'user' = 'user';
  private hasLoadedInbox = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private routeSub: Subscription | null = null;
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

    effect(() => {
      const user = this.auth.user();
      if (!user) return;
      if (!this.feedbackName().trim()) {
        this.feedbackName.set(String(user.displayName || '').trim());
      }
      if (!this.feedbackEmail().trim()) {
        this.feedbackEmail.set(String(user.email || '').trim());
      }
    });
  }

  ngOnInit(): void {
    this.updateMobileState();
    this.refreshInbox(false);
    this.refreshTimer = setInterval(() => this.refreshInbox(true), 5000);
    if (this.auth.isAdmin()) {
      void this.setupProgress.refresh().then(() => {
        if (this.setupProgress.shouldPrompt()) {
          this.showSetupPrompt.set(true);
        }
      });
    }
    this.routeSub = this.router.events
      .pipe(filter(event => event instanceof NavigationEnd))
      .subscribe(() => {
        const path = this.router.url.split('?')[0] || '';
        if (!this.auth.isAdmin()) return;
        if (path !== '/dashboard') return;
        if (this.showSetupPrompt()) return;
        void this.setupProgress.refresh().then(() => {
          if (this.setupProgress.shouldPrompt()) {
            this.showSetupPrompt.set(true);
          }
        });
      });
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.routeSub?.unsubscribe();
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
    this.smsApi.listInbox(this.inboxFetchLimit).subscribe({
      next: smsRes => {
        this.emailApi.listInbox(this.inboxFetchLimit).subscribe({
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
        this.emailApi.listInbox(this.inboxFetchLimit).subscribe({
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

  startSetupWizard(): void {
    this.showSetupPrompt.set(false);
    this.setupProgress.clearDismissed();
    void this.setupProgress.refresh().then(() => {
      const firstMissing = this.setupProgress.pendingItems()[0];
      const section = firstMissing?.section || 'branding';
      this.router.navigate(['/admin-settings'], {
        queryParams: {
          section,
          setupFocus: '1',
          setupStartAt: Date.now()
        }
      });
    });
  }

  skipSetupPrompt(): void {
    this.showSetupPrompt.set(false);
    this.setupProgress.dismissPrompt();
  }

  closeQuickSetup(): void {
    this.quickSetupOpen.set(false);
  }

  quickSetupNext(): void {
    const next = this.quickSetupIndex() + 1;
    if (next >= this.quickSetupItems().length) return;
    this.quickSetupIndex.set(next);
    this.quickSetupError.set('');
    this.quickSetupStatus.set('');
  }

  quickSetupBack(): void {
    const prev = this.quickSetupIndex() - 1;
    if (prev < 0) return;
    this.quickSetupIndex.set(prev);
    this.quickSetupError.set('');
    this.quickSetupStatus.set('');
  }

  async quickSetupSaveCurrent(): Promise<void> {
    const item = this.quickSetupCurrent();
    if (!item) return;
    this.quickSetupBusy.set(true);
    this.quickSetupError.set('');
    this.quickSetupStatus.set('');
    try {
      await this.saveQuickSetupItem(item);
      await this.setupProgress.refresh();
      this.quickSetupStatus.set('Saved.');
      if (this.setupProgress.pendingCount() === 0) {
        this.setupProgress.markDone();
        this.quickSetupOpen.set(false);
        return;
      }
      this.quickSetupIndex.set(0);
    } catch (err: any) {
      this.quickSetupError.set(String(err?.message || 'Could not save setup step.'));
    } finally {
      this.quickSetupBusy.set(false);
    }
  }

  private async saveQuickSetupItem(item: AdminSetupItem): Promise<void> {
    if (item.id === 'business-profile') {
      await firstValueFrom(this.businessProfile.save({
        companyName: this.quickBusinessName.trim(),
        companyEmail: this.quickBusinessEmail.trim(),
        companyPhone: this.quickBusinessPhone.trim(),
        companyAddress: this.quickBusinessAddress.trim()
      }));
      return;
    }
    if (item.id === 'business-hours') {
      const current = await firstValueFrom(this.settingsApi.getValue<any>(SCHEDULE_SETTINGS_KEY));
      const next = {
        ...(current && typeof current === 'object' ? current : {}),
        openHour: this.quickOpenHour,
        closeHour: this.quickCloseHour,
        bays: Array.isArray(current?.bays) && current.bays.length ? current.bays : [{ id: 'bay-1', name: 'Bay 1' }]
      };
      await firstValueFrom(this.settingsApi.setValue(SCHEDULE_SETTINGS_KEY, next));
      return;
    }
    if (item.id === 'payment-gateway') {
      await this.paymentGatewaySettings.setConnection(this.quickPaymentProvider, true, {
        accountLabel: this.quickPaymentAccountLabel.trim(),
        mode: this.quickPaymentMode,
        setAsDefault: true
      });
      return;
    }
    if (item.id === 'email-sender') {
      await firstValueFrom(this.emailApi.setSenderConfig({
        fromEmail: this.quickSenderEmail.trim(),
        fromName: this.quickSenderName.trim() || undefined,
        replyTo: this.quickSenderReplyTo.trim() || undefined
      }));
      return;
    }
    if (item.id === 'email-templates') {
      await firstValueFrom(this.emailApi.upsertTemplate({
        name: this.quickTemplateName.trim(),
        subject: this.quickTemplateSubject.trim(),
        body: this.quickTemplateBody.trim()
      }));
      return;
    }
    if (item.id === 'user-access') {
      await firstValueFrom(this.accessApi.inviteUser({
        name: this.quickUserName.trim(),
        email: this.quickUserEmail.trim().toLowerCase(),
        role: this.quickUserRole
      }));
      return;
    }
    if (item.id === 'logo') {
      throw new Error('Use the logo upload field below.');
    }
  }

  async quickUploadLogo(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.quickSetupBusy.set(true);
    this.quickSetupError.set('');
    try {
      const fileDataUrl = await this.readFileAsDataUrl(file);
      const result = await firstValueFrom(
        this.brandingApi.uploadLogo(file.name, file.type || 'application/octet-stream', fileDataUrl)
      );
      this.branding.setLogoUrl(result.url);
      await this.setupProgress.refresh();
      this.quickSetupStatus.set('Logo uploaded.');
      this.quickSetupIndex.set(0);
    } catch {
      this.quickSetupError.set('Could not upload logo.');
    } finally {
      this.quickSetupBusy.set(false);
      input.value = '';
    }
  }

  private seedQuickSetupDrafts(): void {
    const profile = this.businessProfile.profile();
    this.quickBusinessName = String(profile.companyName || '').trim();
    this.quickBusinessEmail = String(profile.companyEmail || '').trim();
    this.quickBusinessPhone = String(profile.companyPhone || '').trim();
    this.quickBusinessAddress = String(profile.companyAddress || '').trim();
    this.quickPaymentProvider = this.paymentGatewaySettings.defaultProvider()?.key || 'authorize-net';
    this.quickPaymentAccountLabel = this.paymentGatewaySettings.providerByKey(this.quickPaymentProvider)?.accountLabel || '';
    this.quickPaymentMode = this.paymentGatewaySettings.providerByKey(this.quickPaymentProvider)?.mode || 'test';
    this.quickSenderEmail = String(this.auth.user()?.email || '').trim().toLowerCase();
    this.quickTemplateName = 'Welcome Template';
    this.quickTemplateSubject = 'Welcome to our shop';
    this.quickTemplateBody = '<p>Thanks for choosing us.</p>';
  }

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Unable to read file.'));
      reader.readAsDataURL(file);
    });
  }

  toggleFeedback(): void {
    const next = !this.feedbackOpen();
    this.feedbackOpen.set(next);
    this.feedbackStatus.set('');
    this.feedbackError.set('');
  }

  closeFeedback(): void {
    this.feedbackOpen.set(false);
    this.feedbackStatus.set('');
    this.feedbackError.set('');
  }

  submitFeedback(): void {
    if (this.feedbackSending()) return;
    const name = this.feedbackName().trim();
    const email = this.feedbackEmail().trim();
    const issue = this.feedbackIssue().trim();
    if (!name || !email || !issue) {
      this.feedbackError.set('Name, email, and issue details are required.');
      this.feedbackStatus.set('');
      return;
    }

    const currentHref = window.location.href;
    const currentRoute = this.router.url || '/';
    const timestamp = new Date().toISOString();
    const body = [
      'Pathflow feedback submission',
      '',
      `Name: ${name}`,
      `Email: ${email}`,
      `Current route: ${currentRoute}`,
      `Screen link: ${currentHref}`,
      `Submitted at: ${timestamp}`,
      `User agent: ${navigator.userAgent}`,
      '',
      'Issue details:',
      issue
    ].join('\n');
    const subject = `Pathflow Feedback - ${currentRoute}`;
    this.feedbackSending.set(true);
    this.feedbackStatus.set('');
    this.feedbackError.set('');

    this.emailApi.sendToCustomer({
      customerId: '',
      customerName: name,
      to: this.feedbackRecipient,
      subject,
      message: body,
      skipFooterTerms: true
    }).subscribe({
      next: result => {
        this.feedbackSending.set(false);
        const toastMessage = result.simulated ? 'Feedback logged (mock mode).' : 'Feedback sent.';
        this.feedbackStatus.set(toastMessage);
        this.feedbackError.set('');
        this.feedbackIssue.set('');
        this.feedbackOpen.set(false);
        void this.presentFeedbackToast(toastMessage, result.simulated ? 'medium' : 'success');
      },
      error: err => {
        this.feedbackSending.set(false);
        const detail = String(err?.error?.error || err?.error?.message || err?.message || '').trim();
        this.feedbackError.set(detail || 'Could not send feedback email.');
        this.feedbackStatus.set('');
      }
    });
  }

  private async presentFeedbackToast(message: string, color: 'success' | 'medium' = 'success'): Promise<void> {
    const toast = await this.toastController.create({
      message,
      color,
      duration: 1800,
      position: 'top'
    });
    await toast.present();
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
