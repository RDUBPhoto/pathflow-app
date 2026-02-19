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
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  chatbubbleEllipsesOutline,
  paperPlaneOutline,
  searchOutline
} from 'ionicons/icons';
import { CustomersApi, Customer } from '../../services/customers-api.service';
import { SmsApiService, SmsDeliveryStatus, SmsMessage, SmsThreadSummary } from '../../services/sms-api.service';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';

type ThreadView = SmsThreadSummary & {
  displayName: string;
  displayPhone: string;
  initials: string;
  color: string;
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
    IonInput,
    IonTextarea,
    IonBadge,
    IonSpinner,
    UserMenuComponent,
    PageBackButtonComponent
  ],
  templateUrl: './messages.component.html',
  styleUrls: ['./messages.component.scss']
})
export default class MessagesComponent implements OnInit, OnDestroy {
  @ViewChild('messageScroll') private messageScroll?: ElementRef<HTMLDivElement>;

  private readonly smsApi = inject(SmsApiService);
  private readonly customersApi = inject(CustomersApi);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  readonly loadingThreads = signal(false);
  readonly loadingMessages = signal(false);
  readonly sending = signal(false);
  readonly error = signal('');
  readonly status = signal('');
  readonly searchTerm = signal('');
  readonly threads = signal<SmsThreadSummary[]>([]);
  readonly customersById = signal<Record<string, Customer>>({});
  readonly selectedThreadKey = signal<string | null>(null);
  readonly messages = signal<SmsMessage[]>([]);
  outgoingMessage = '';

  readonly threadViews = computed<ThreadView[]>(() => {
    const customerMap = this.customersById();
    return this.threads().map(thread => {
      const customer = thread.customerId ? customerMap[thread.customerId] : undefined;
      const displayName = (customer?.name || thread.customerName || 'Unknown customer').trim();
      const displayPhone = (customer?.phone || thread.customerPhone || '').trim();
      return {
        ...thread,
        displayName,
        displayPhone,
        initials: this.initialsFor(displayName),
        color: this.colorForSeed(thread.customerId || thread.key)
      };
    });
  });

  readonly filteredThreadViews = computed(() => {
    const q = this.searchTerm().trim().toLowerCase();
    const all = this.threadViews();
    if (!q) return all;
    return all.filter(thread => {
      const hay = [
        thread.displayName,
        thread.displayPhone,
        thread.latestMessage
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  });

  readonly selectedThread = computed(() => {
    const key = this.selectedThreadKey();
    if (!key) return null;
    return this.threadViews().find(thread => thread.key === key) || null;
  });

  ngOnInit(): void {
    addIcons({
      'chatbubble-ellipses-outline': chatbubbleEllipsesOutline,
      'paper-plane-outline': paperPlaneOutline,
      'search-outline': searchOutline
    });

    this.loadCustomers();
    this.refreshThreads();
    this.refreshTimer = setInterval(() => this.refreshThreads(false), 5000);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  selectThread(thread: ThreadView): void {
    if (this.selectedThreadKey() === thread.key) return;
    this.selectedThreadKey.set(thread.key);
    this.status.set('');
    if (thread.customerId) {
      this.loadMessages(thread.customerId);
    } else {
      this.messages.set([]);
    }
  }

  sendMessage(): void {
    const thread = this.selectedThread();
    if (!thread || !thread.customerId) {
      this.error.set('Select a customer thread to send a message.');
      return;
    }
    const message = this.outgoingMessage.trim();
    if (!message) return;

    const to = this.normalizeE164(thread.displayPhone || thread.customerPhone || '');
    if (!to) {
      this.error.set('Customer phone is missing or invalid.');
      return;
    }

    this.sending.set(true);
    this.error.set('');
    this.status.set('');
    this.smsApi
      .sendToCustomer({
        customerId: thread.customerId,
        customerName: thread.displayName,
        to,
        message
      })
      .subscribe({
        next: res => {
          this.sending.set(false);
          this.outgoingMessage = '';
          this.status.set(res.simulated ? 'Mock SMS logged.' : 'SMS sent.');
          this.loadMessages(thread.customerId || '');
          this.refreshThreads(false);
        },
        error: err => {
          this.sending.set(false);
          this.error.set(this.extractError(err, 'Failed to send SMS.'));
        }
      });
  }

  onComposerKeydown(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (!keyboard || keyboard.key !== 'Enter') return;
    if (keyboard.shiftKey || keyboard.altKey || keyboard.ctrlKey || keyboard.metaKey) return;
    if ((keyboard as unknown as { isComposing?: boolean }).isComposing) return;
    keyboard.preventDefault();
    if (this.sending()) return;
    this.sendMessage();
  }

  smsDateLabel(value: string): string {
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
    return thread.key;
  }

  trackMessage(_index: number, message: SmsMessage): string {
    return message.id;
  }

  threadDeliveryLabel(thread: ThreadView): string {
    if (thread.latestDirection !== 'outbound') return '';
    return this.deliveryLabel(thread.latestDeliveryStatus || 'queued');
  }

  threadDeliveryClass(thread: ThreadView): string {
    if (thread.latestDirection !== 'outbound') return 'queued';
    return this.deliveryClass(thread.latestDeliveryStatus || 'queued');
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

  private loadCustomers(): void {
    this.customersApi.list().subscribe({
      next: list => {
        const map: Record<string, Customer> = {};
        for (const customer of list) {
          map[customer.id] = customer;
        }
        this.customersById.set(map);
      }
    });
  }

  private refreshThreads(adjustSelection = true): void {
    if (adjustSelection) this.loadingThreads.set(true);
    this.smsApi.listThreads().subscribe({
      next: res => {
        const next = Array.isArray(res.items) ? res.items : [];
        this.threads.set(next);
        if (adjustSelection) this.loadingThreads.set(false);

        if (!next.length) {
          this.selectedThreadKey.set(null);
          this.messages.set([]);
          return;
        }

        const selected = this.selectedThreadKey();
        const stillExists = !!selected && next.some(thread => thread.key === selected);
        if (!stillExists) {
          const first = next[0];
          this.selectedThreadKey.set(first.key);
          if (first.customerId) this.loadMessages(first.customerId);
          return;
        }

        const current = next.find(thread => thread.key === selected);
        if (current?.customerId) {
          this.loadMessages(current.customerId, false);
        }
      },
      error: err => {
        if (adjustSelection) this.loadingThreads.set(false);
        this.error.set(this.extractError(err, 'Could not load message threads.'));
      }
    });
  }

  private loadMessages(customerId: string, showSpinner = true): void {
    if (!customerId) return;
    if (showSpinner) this.loadingMessages.set(true);
    this.smsApi.listCustomerMessages(customerId).subscribe({
      next: res => {
        if (showSpinner) this.loadingMessages.set(false);
        const items = Array.isArray(res.items) ? res.items : [];
        this.messages.set(items);
        this.scrollToBottom();
        this.markThreadRead(items);
      },
      error: err => {
        if (showSpinner) this.loadingMessages.set(false);
        this.error.set(this.extractError(err, 'Could not load conversation.'));
      }
    });
  }

  private markThreadRead(items: SmsMessage[]): void {
    const unreadIds = items
      .filter(item => item.direction === 'inbound' && !item.read)
      .map(item => item.id);
    if (!unreadIds.length) return;
    this.smsApi.markReadBatch(unreadIds).subscribe({
      next: () => this.refreshThreads(false)
    });
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

  private initialsFor(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'SMS';
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
}
