import { CommonModule } from '@angular/common';
import { Component, ElementRef, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  chatbubbleEllipsesOutline,
  arrowRedoOutline,
  arrowUndoOutline,
  mailOutline,
  paperPlaneOutline,
  searchOutline
} from 'ionicons/icons';
import { ActivatedRoute } from '@angular/router';
import { CustomersApi, Customer } from '../../services/customers-api.service';
import { SmsApiService, SmsDeliveryStatus, SmsMessage, SmsThreadSummary } from '../../services/sms-api.service';
import { EmailApiService, EmailMessage, EmailTemplate, EmailThreadSummary } from '../../services/email-api.service';
import { AuthService } from '../../auth/auth.service';
import { TenantContextService } from '../../services/tenant-context.service';
import { BrandSettingsService } from '../../services/brand-settings.service';
import { BusinessProfileService } from '../../services/business-profile.service';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { environment } from '../../../environments/environment';

type Channel = 'sms' | 'email';

type ThreadView = {
  id: string;
  key: string;
  channel: Channel;
  customerId: string | null;
  displayName: string;
  displayContact: string;
  initials: string;
  color: string;
  latestAt: string;
  latestPreview: string;
  latestDirection: 'inbound' | 'outbound';
  unread: number;
  latestSmsDeliveryStatus?: SmsDeliveryStatus;
  latestEmailSubject?: string;
};

@Component({
  selector: 'app-messages-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonContent,
    IonIcon,
    IonButton,
    IonItem,
    IonLabel,
    IonSelect,
    IonSelectOption,
    IonInput,
    IonTextarea,
    IonBadge,
    IonSpinner,
    UserMenuComponent,
    PageBackButtonComponent,
    CompanySwitcherComponent
  ],
  templateUrl: './messages.component.html',
  styleUrls: ['./messages.component.scss']
})
export default class MessagesComponent implements OnInit, OnDestroy {
  @ViewChild('messageScroll') private messageScroll?: ElementRef<HTMLDivElement>;

  private readonly smsApi = inject(SmsApiService);
  private readonly emailApi = inject(EmailApiService);
  private readonly customersApi = inject(CustomersApi);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly tenantContext = inject(TenantContextService);
  private readonly branding = inject(BrandSettingsService);
  private readonly businessProfile = inject(BusinessProfileService);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  readonly activeChannel = signal<Channel>('sms');
  readonly loadingThreads = signal(false);
  readonly loadingMessages = signal(false);
  readonly sending = signal(false);
  readonly error = signal('');
  readonly status = signal('');
  readonly searchTerm = signal('');
  readonly smsThreads = signal<SmsThreadSummary[]>([]);
  readonly emailThreads = signal<EmailThreadSummary[]>([]);
  readonly customersById = signal<Record<string, Customer>>({});
  readonly selectedThreadId = signal<string | null>(null);
  readonly smsMessages = signal<SmsMessage[]>([]);
  readonly emailMessages = signal<EmailMessage[]>([]);
  readonly emailTemplates = signal<EmailTemplate[]>([]);
  readonly emailSignature = signal('');

  outgoingMessage = '';
  outgoingEmailTo = '';
  outgoingEmailSubject = '';
  selectedEmailTemplateId = '';

  readonly allThreads = computed<ThreadView[]>(() => {
    const customers = this.customersById();
    const sms = this.smsThreads().map(thread => this.toSmsThreadView(thread, customers));
    const email = this.emailThreads().map(thread => this.toEmailThreadView(thread, customers));
    return [...sms, ...email].sort((a, b) => this.timeValue(b.latestAt) - this.timeValue(a.latestAt));
  });

  readonly filteredThreads = computed(() => {
    const q = this.searchTerm().trim().toLowerCase();
    const all = this.allThreads().filter(thread => thread.channel === this.activeChannel());
    if (!q) return all;
    return all.filter(thread => {
      const haystack = [thread.displayName, thread.displayContact, thread.latestPreview, thread.latestEmailSubject || '']
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  });

  readonly selectedThread = computed(() => {
    const selectedId = this.selectedThreadId();
    if (!selectedId) return null;
    return this.allThreads().find(thread => thread.id === selectedId) || null;
  });

  readonly selectedSmsMessages = computed(() => this.smsMessages());
  readonly selectedEmailMessages = computed(() => this.emailMessages());

  ngOnInit(): void {
    addIcons({
      'chatbubble-ellipses-outline': chatbubbleEllipsesOutline,
      'mail-outline': mailOutline,
      'arrow-undo-outline': arrowUndoOutline,
      'arrow-redo-outline': arrowRedoOutline,
      'paper-plane-outline': paperPlaneOutline,
      'search-outline': searchOutline
    });

    const queryChannel = String(this.route.snapshot.queryParamMap.get('channel') || '').toLowerCase();
    if (queryChannel === 'email') {
      this.activeChannel.set('email');
    } else if (queryChannel === 'sms') {
      this.activeChannel.set('sms');
    }

    this.loadCustomers();
    this.loadEmailTemplates();
    this.refreshThreads(true);
    this.refreshTimer = setInterval(() => this.refreshThreads(false), 5000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  setChannel(channel: Channel): void {
    if (this.activeChannel() === channel) return;
    this.activeChannel.set(channel);
    this.searchTerm.set('');
    this.error.set('');
    this.status.set('');
    this.outgoingMessage = '';
    this.selectedEmailTemplateId = '';
    if (channel === 'email') {
      this.outgoingEmailTo = '';
      this.outgoingEmailSubject = '';
    }

    const selected = this.selectedThread();
    if (selected && selected.channel === channel) return;
    const first = this.filteredThreads()[0] || null;
    if (!first) {
      this.selectedThreadId.set(null);
      this.smsMessages.set([]);
      this.emailMessages.set([]);
      return;
    }
    this.selectThread(first);
  }

  selectThread(thread: ThreadView): void {
    if (this.selectedThreadId() === thread.id) return;
    this.selectedThreadId.set(thread.id);
    this.status.set('');
    this.error.set('');

    if (!thread.customerId) {
      this.smsMessages.set([]);
      this.emailMessages.set([]);
      return;
    }

    if (thread.channel === 'sms') {
      this.loadSmsMessages(thread.customerId);
      return;
    }

    this.selectedEmailTemplateId = '';
    this.loadEmailMessages(thread.customerId);
  }

  canSendMessage(): boolean {
    const selected = this.selectedThread();
    if (!selected || !selected.customerId || this.sending()) return false;
    if (selected.channel === 'sms') {
      return !!this.outgoingMessage.trim();
    }
    return this.isValidEmail(this.outgoingEmailTo.trim() || selected.displayContact || '')
      && !!this.outgoingEmailSubject.trim()
      && !!this.outgoingMessage.trim();
  }

  sendMessage(): void {
    const selected = this.selectedThread();
    if (!selected || !selected.customerId) {
      this.error.set('Select a customer thread first.');
      return;
    }

    if (selected.channel === 'sms') {
      this.sendSmsMessage(selected);
      return;
    }

    this.sendEmailMessage(selected);
  }

  onComposerKeydown(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (!keyboard || keyboard.key !== 'Enter') return;
    if (keyboard.shiftKey || keyboard.altKey || keyboard.ctrlKey || keyboard.metaKey) return;
    if ((keyboard as unknown as { isComposing?: boolean }).isComposing) return;
    keyboard.preventDefault();
    if (this.sending()) return;
    if (this.selectedThread()?.channel !== 'sms') return;
    this.sendMessage();
  }

  prepareReplyEmail(): void {
    const selected = this.selectedThread();
    if (!selected || selected.channel !== 'email') return;
    const latest = this.latestEmailMessage();
    if (!latest) return;

    const recipient = String(latest.direction === 'inbound' ? latest.from : latest.to || '').trim();
    if (this.isValidEmail(recipient)) {
      this.outgoingEmailTo = recipient;
    }

    const currentSubject = String(latest.subject || '').trim();
    this.outgoingEmailSubject = currentSubject
      ? (/^re:/i.test(currentSubject) ? currentSubject : `Re: ${currentSubject}`)
      : 'Re:';

    const senderLabel = latest.direction === 'inbound' ? (latest.from || 'customer') : 'you';
    const original = String(latest.message || '').trim();
    const quoted = original
      ? original.split('\n').map(line => `> ${line}`).join('\n')
      : '> (no original body)';

    this.outgoingMessage = this.composeEmailBody('', `On ${this.dateLabel(latest.createdAt)}, ${senderLabel} wrote:\n${quoted}`);
  }

  prepareForwardEmail(): void {
    const selected = this.selectedThread();
    if (!selected || selected.channel !== 'email') return;
    const latest = this.latestEmailMessage();
    if (!latest) return;

    const currentSubject = String(latest.subject || '').trim();
    this.outgoingEmailSubject = currentSubject
      ? (/^fwd:/i.test(currentSubject) ? currentSubject : `Fwd: ${currentSubject}`)
      : 'Fwd:';
    this.outgoingEmailTo = '';

    const from = String(latest.from || '').trim() || '(unknown sender)';
    const to = String(latest.to || '').trim() || '(unknown recipient)';
    const body = String(latest.message || '').trim();

    const forwardBlock = [
      '',
      '---------- Forwarded message ---------',
      `From: ${from}`,
      `Date: ${this.dateLabel(latest.createdAt)}`,
      `To: ${to}`,
      `Subject: ${currentSubject || '(no subject)'}`,
      '',
      body
    ].join('\n');
    this.outgoingMessage = this.composeEmailBody('', forwardBlock);
  }

  applyEmailTemplate(templateId: string | null | undefined): void {
    this.selectedEmailTemplateId = String(templateId || '');
    if (!this.selectedEmailTemplateId) return;
    const template = this.emailTemplates().find(item => item.id === this.selectedEmailTemplateId);
    if (!template) return;
    const mergeValues = this.emailMergeTagValues();
    this.outgoingEmailSubject = this.resolveEmailMergeTags(String(template.subject || '').trim(), mergeValues);
    this.outgoingMessage = this.composeEmailBody(
      this.resolveEmailMergeTags(String(template.body || '').trim(), mergeValues)
    );
  }

  dateLabel(value: string): string {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return value;
    return new Date(parsed).toLocaleString();
  }

  relativeTimeLabel(value: string): string {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return '';
    const delta = Date.now() - parsed;
    const mins = Math.max(1, Math.floor(delta / 60000));
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  }

  trackThread(_index: number, thread: ThreadView): string {
    return thread.id;
  }

  trackSmsMessage(_index: number, message: SmsMessage): string {
    return message.id;
  }

  trackEmailMessage(_index: number, message: EmailMessage): string {
    return message.id;
  }

  threadDeliveryLabel(thread: ThreadView): string {
    if (thread.channel !== 'sms' || thread.latestDirection !== 'outbound') return '';
    return this.deliveryLabel(thread.latestSmsDeliveryStatus || 'queued');
  }

  threadDeliveryClass(thread: ThreadView): string {
    if (thread.channel !== 'sms' || thread.latestDirection !== 'outbound') return 'queued';
    return this.deliveryClass(thread.latestSmsDeliveryStatus || 'queued');
  }

  messageDeliveryLabel(message: SmsMessage): string {
    return this.deliveryLabel(this.deliveryStatusOf(message));
  }

  messageDeliveryClass(message: SmsMessage): string {
    return this.deliveryClass(this.deliveryStatusOf(message));
  }

  messageDeliveryTitle(message: SmsMessage): string {
    const parts = [
      this.messageDeliveryLabel(message),
      message.providerErrorMessage || '',
      message.providerErrorCode ? `code: ${message.providerErrorCode}` : ''
    ].filter(Boolean);
    return parts.join(' • ');
  }

  private sendSmsMessage(selected: ThreadView): void {
    const message = this.outgoingMessage.trim();
    if (!message) return;

    const to = this.normalizeE164(selected.displayContact || '');
    if (!to) {
      this.error.set('Customer phone is missing or invalid.');
      return;
    }

    this.sending.set(true);
    this.error.set('');
    this.status.set('');
    this.smsApi.sendToCustomer({
      customerId: selected.customerId || '',
      customerName: selected.displayName,
      to,
      message
    }).subscribe({
      next: res => {
        this.sending.set(false);
        this.outgoingMessage = '';
        this.status.set(res.simulated ? 'Mock SMS logged.' : 'SMS sent.');
        if (selected.customerId) this.loadSmsMessages(selected.customerId, false);
        this.refreshThreads(false);
      },
      error: err => {
        this.sending.set(false);
        this.error.set(this.extractError(err, 'Failed to send SMS.'));
      }
    });
  }

  private sendEmailMessage(selected: ThreadView): void {
    const mergeValues = this.emailMergeTagValues();
    const to = this.resolveEmailMergeTags(this.outgoingEmailTo.trim() || selected.displayContact || '', mergeValues);
    const subject = this.resolveEmailMergeTags(this.outgoingEmailSubject.trim(), mergeValues);
    const message = this.resolveEmailMergeTags(this.outgoingMessage.trim(), mergeValues);
    const html = this.looksLikeHtmlContent(message) ? this.normalizeEmailHtmlAssets(message) : '';
    const textMessage = html ? this.htmlToPlainText(message) : message;

    if (!this.isValidEmail(to)) {
      this.error.set('Recipient email is missing or invalid.');
      return;
    }
    if (!subject) {
      this.error.set('Email subject is required.');
      return;
    }
    if (!textMessage) {
      this.error.set('Email message cannot be empty.');
      return;
    }

    this.sending.set(true);
    this.error.set('');
    this.status.set('');
    this.emailApi.sendToCustomer({
      customerId: selected.customerId || '',
      customerName: selected.displayName,
      to,
      subject,
      message: textMessage,
      html: html || undefined
    }).subscribe({
      next: () => {
        this.sending.set(false);
        this.outgoingMessage = '';
        this.status.set('Email sent.');
        if (selected.customerId) this.loadEmailMessages(selected.customerId, false);
        this.refreshThreads(false);
      },
      error: err => {
        this.sending.set(false);
        this.error.set(this.extractError(err, 'Failed to send email.'));
      }
    });
  }

  private loadCustomers(): void {
    this.customersApi.list().subscribe({
      next: list => {
        const map: Record<string, Customer> = {};
        for (const customer of list) map[customer.id] = customer;
        this.customersById.set(map);
      }
    });
  }

  private loadEmailTemplates(): void {
    this.emailApi.listTemplates().subscribe({
      next: res => {
        this.emailTemplates.set(Array.isArray(res.templates) ? res.templates : []);
        this.emailSignature.set(typeof res.signature === 'string' ? res.signature.trim() : '');
      },
      error: err => {
        this.error.set(this.extractError(err, 'Could not load email templates.'));
      }
    });
  }

  private refreshThreads(adjustSelection = true): void {
    if (adjustSelection) this.loadingThreads.set(true);
    this.error.set('');

    let smsRes: SmsThreadSummary[] = [];
    let emailRes: EmailThreadSummary[] = [];

    this.smsApi.listThreads().subscribe({
      next: sms => {
        smsRes = Array.isArray(sms.items) ? sms.items : [];
        this.emailApi.listThreads().subscribe({
          next: email => {
            emailRes = Array.isArray(email.items) ? email.items : [];
            this.smsThreads.set(smsRes);
            this.emailThreads.set(emailRes);
            if (adjustSelection) this.loadingThreads.set(false);
            this.syncSelectionAfterRefresh();
          },
          error: err => {
            if (adjustSelection) this.loadingThreads.set(false);
            this.error.set(this.extractError(err, 'Could not load email threads.'));
          }
        });
      },
      error: err => {
        if (adjustSelection) this.loadingThreads.set(false);
        this.error.set(this.extractError(err, 'Could not load SMS threads.'));
      }
    });
  }

  private syncSelectionAfterRefresh(): void {
    const all = this.filteredThreads();
    if (!all.length) {
      this.selectedThreadId.set(null);
      this.smsMessages.set([]);
      this.emailMessages.set([]);
      return;
    }

    const selectedId = this.selectedThreadId();
    const selected = selectedId ? all.find(thread => thread.id === selectedId) || null : null;
    if (!selected) {
      this.selectThread(all[0]);
      return;
    }

    if (selected.customerId) {
      if (selected.channel === 'sms') this.loadSmsMessages(selected.customerId, false);
      if (selected.channel === 'email') this.loadEmailMessages(selected.customerId, false);
    }
  }

  private loadSmsMessages(customerId: string, showSpinner = true): void {
    if (!customerId) return;
    if (showSpinner) this.loadingMessages.set(true);
    this.smsApi.listCustomerMessages(customerId).subscribe({
      next: res => {
        if (showSpinner) this.loadingMessages.set(false);
        const items = Array.isArray(res.items) ? res.items : [];
        this.smsMessages.set(items);
        this.scrollToBottom();
        this.markSmsThreadRead(items);
      },
      error: err => {
        if (showSpinner) this.loadingMessages.set(false);
        this.error.set(this.extractError(err, 'Could not load SMS conversation.'));
      }
    });
  }

  private loadEmailMessages(customerId: string, showSpinner = true): void {
    if (!customerId) return;
    if (showSpinner) this.loadingMessages.set(true);
    this.emailApi.listCustomerMessages(customerId).subscribe({
      next: res => {
        if (showSpinner) this.loadingMessages.set(false);
        const items = Array.isArray(res.items) ? res.items : [];
        this.emailMessages.set(items);
        const thread = this.selectedThread();
        if (thread?.channel === 'email') {
          this.outgoingEmailTo = thread.displayContact || '';
          if (!this.outgoingEmailSubject.trim() && thread.latestEmailSubject) {
            this.outgoingEmailSubject = /^re:/i.test(thread.latestEmailSubject)
              ? thread.latestEmailSubject
              : `Re: ${thread.latestEmailSubject}`;
          }
          if (!this.outgoingMessage.trim()) {
            this.outgoingMessage = this.composeEmailBody('');
          }
        }
        this.scrollToBottom();
        this.markEmailThreadRead(items);
      },
      error: err => {
        if (showSpinner) this.loadingMessages.set(false);
        this.error.set(this.extractError(err, 'Could not load email conversation.'));
      }
    });
  }

  private markSmsThreadRead(items: SmsMessage[]): void {
    const unreadIds = items.filter(item => item.direction === 'inbound' && !item.read).map(item => item.id);
    if (!unreadIds.length) return;
    this.smsApi.markReadBatch(unreadIds).subscribe({
      next: () => this.refreshThreads(false)
    });
  }

  private markEmailThreadRead(items: EmailMessage[]): void {
    const unreadIds = items.filter(item => item.direction === 'inbound' && !item.read).map(item => item.id);
    if (!unreadIds.length) return;
    this.emailApi.markReadBatch(unreadIds).subscribe({
      next: () => this.refreshThreads(false)
    });
  }

  private latestEmailMessage(): EmailMessage | null {
    const items = this.emailMessages();
    if (!items.length) return null;
    return items[items.length - 1] || null;
  }

  private toSmsThreadView(thread: SmsThreadSummary, customers: Record<string, Customer>): ThreadView {
    const customer = thread.customerId ? customers[thread.customerId] : undefined;
    const displayName = (customer?.name || thread.customerName || 'Unknown customer').trim();
    const displayContact = (customer?.phone || thread.customerPhone || '').trim();
    return {
      id: `sms:${thread.key}`,
      key: thread.key,
      channel: 'sms',
      customerId: thread.customerId || null,
      displayName,
      displayContact,
      initials: this.initialsFor(displayName, 'SMS'),
      color: this.colorForSeed(thread.customerId || thread.key),
      latestAt: thread.latestAt,
      latestPreview: thread.latestMessage || '',
      latestDirection: thread.latestDirection,
      unread: Number(thread.unread || 0),
      latestSmsDeliveryStatus: (thread.latestDeliveryStatus || 'queued') as SmsDeliveryStatus
    };
  }

  private toEmailThreadView(thread: EmailThreadSummary, customers: Record<string, Customer>): ThreadView {
    const customer = thread.customerId ? customers[thread.customerId] : undefined;
    const displayName = (customer?.name || thread.customerName || 'Unknown customer').trim();
    const displayContact = (customer?.email || thread.customerEmail || '').trim();
    const preview = (thread.latestMessage || '').trim() || '(no content)';
    return {
      id: `email:${thread.key}`,
      key: thread.key,
      channel: 'email',
      customerId: thread.customerId || null,
      displayName,
      displayContact,
      initials: this.initialsFor(displayName, 'EM'),
      color: this.colorForSeed(thread.customerId || thread.key),
      latestAt: thread.latestAt,
      latestPreview: preview,
      latestDirection: thread.latestDirection,
      unread: Number(thread.unread || 0),
      latestEmailSubject: thread.latestSubject || ''
    };
  }

  private scrollToBottom(): void {
    if (typeof window === 'undefined') return;
    const jump = () => {
      const el = this.messageScroll?.nativeElement;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    };
    jump();
    requestAnimationFrame(jump);
    setTimeout(jump, 80);
  }

  private normalizeE164(value: string): string | null {
    const digits = (value || '').replace(/\D+/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
    return null;
  }

  private isValidEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
  }

  private composeEmailBody(content: string, trailingBlock = ''): string {
    const trimmedContent = String(content || '').trim();
    const signature = String(this.emailSignature() || '').trim();
    if (this.looksLikeHtmlContent(trimmedContent)) {
      return this.appendHtmlSignature(trimmedContent, signature);
    }
    const withSignature = signature
      ? [trimmedContent, signature].filter(section => !!section).join('\n\n')
      : trimmedContent;
    const trailing = String(trailingBlock || '').trim();
    if (!trailing) return withSignature;
    return [withSignature, trailing].filter(section => !!section).join('\n\n');
  }

  private emailMergeTagValues(): Record<string, string> {
    const selected = this.selectedThread();
    const customer = selected?.customerId ? this.customersById()[selected.customerId] : null;
    const customerName = String(selected?.displayName || customer?.name || '').trim();
    const customerEmail = String(customer?.email || (selected?.channel === 'email' ? selected.displayContact : '') || '').trim();
    const customerPhone = String(customer?.phone || (selected?.channel === 'sms' ? selected.displayContact : '') || '').trim();
    const companyName = this.activeCompanyName();
    const logoUrl = this.toEmailAssetUrl(String(this.branding.logoUrl() || '').trim());
    const profile = this.businessProfile.profile();
    return {
      company_name: companyName,
      company_logo_url: logoUrl,
      company_email: profile.companyEmail || '',
      company_phone: profile.companyPhone || '',
      company_address: profile.companyAddress || '',
      company_location: profile.companyAddress || '',
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: customerPhone,
      lead_message: ''
    };
  }

  private activeCompanyName(): string {
    const profileName = String(this.businessProfile.profile().companyName || '').trim();
    if (profileName) return profileName;
    const tenantId = String(this.tenantContext.tenantId() || '').trim();
    const locations = this.auth.locations();
    const selected = tenantId
      ? locations.find(location => String(location.id || '').trim() === tenantId)
      : null;
    const fallback = selected?.name || locations[0]?.name || '';
    return String(fallback || 'Your Company').trim();
  }

  private resolveEmailMergeTags(template: string, values: Record<string, string>): string {
    const source = String(template || '');
    if (!source) return '';
    return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_full, rawKey: string) => {
      const key = String(rawKey || '').toLowerCase();
      if (!key) return '';
      return String(values[key] ?? '').trim();
    });
  }

  private toEmailAssetUrl(value: string): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!raw.startsWith('/')) return raw;
    const publicBase = String(environment.publicAppUrl || '').trim().replace(/\/+$/, '');
    if (publicBase) return `${publicBase}${raw}`;
    if (typeof window !== 'undefined' && window.location?.origin) {
      return `${window.location.origin.replace(/\/+$/, '')}${raw}`;
    }
    return raw;
  }

  private looksLikeHtmlContent(value: string): boolean {
    return /<[^>]+>/.test(String(value || '').trim());
  }

  private htmlToPlainText(html: string): string {
    return String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeEmailHtmlAssets(html: string): string {
    const source = String(html || '');
    if (!source) return '';
    return source.replace(
      /(src|href)\s*=\s*(["'])(\/[^"']*)\2/gi,
      (_full, attr: string, quote: string, rawPath: string) => `${attr}=${quote}${this.toEmailAssetUrl(rawPath)}${quote}`
    );
  }

  private appendHtmlSignature(baseHtml: string, signature: string): string {
    const normalizedBase = String(baseHtml || '').trim();
    const normalizedSignature = String(signature || '').trim();
    if (!normalizedSignature) return normalizedBase;
    const signatureHtml = this.looksLikeHtmlContent(normalizedSignature)
      ? normalizedSignature
      : this.escapeHtml(normalizedSignature).replace(/\n/g, '<br/>');
    if (!normalizedBase) return signatureHtml;
    return `${normalizedBase}<br/><br/>${signatureHtml}`;
  }

  private escapeHtml(value: string): string {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private initialsFor(name: string, fallback = 'MSG'): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return fallback;
    const first = parts[0].charAt(0);
    const second = parts.length > 1 ? parts[1].charAt(0) : parts[0].charAt(1);
    return `${first}${second || ''}`.toUpperCase();
  }

  private colorForSeed(seed: string): string {
    const palette = ['#1d4ed8', '#0f766e', '#b45309', '#be185d', '#4c1d95', '#374151'];
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(i);
      hash |= 0;
    }
    return palette[Math.abs(hash) % palette.length];
  }

  private extractError(err: unknown, fallback: string): string {
    if (err instanceof HttpErrorResponse) {
      const detail = typeof err.error === 'object' && err.error !== null
        ? (err.error.detail || err.error.error || err.message)
        : err.message;
      return `${fallback} ${String(detail)}`.trim();
    }
    return fallback;
  }

  private deliveryStatusOf(message: SmsMessage): SmsDeliveryStatus {
    const raw = (message.deliveryStatus || '').toString().toLowerCase();
    if (raw === 'delivered') return 'delivered';
    if (raw === 'failed') return 'failed';
    if (raw === 'received') return 'received';
    if (raw === 'queued') return 'queued';
    return message.direction === 'inbound' ? 'received' : 'queued';
  }

  private deliveryLabel(status: SmsDeliveryStatus): string {
    if (status === 'delivered') return 'Delivered';
    if (status === 'failed') return 'Failed';
    if (status === 'received') return 'Received';
    return 'Queued';
  }

  private deliveryClass(status: SmsDeliveryStatus): string {
    if (status === 'delivered') return 'delivered';
    if (status === 'failed') return 'failed';
    if (status === 'received') return 'received';
    return 'queued';
  }

  private timeValue(value: string): number {
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }
}
