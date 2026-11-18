import { CommonModule } from '@angular/common';
import { Component, HostListener, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { InvoicesDataService } from '../../services/invoices-data.service';
import { TenantContextService } from '../../services/tenant-context.service';
import { firstValueFrom } from 'rxjs';
import { QuoteResponseApiService } from '../../services/quote-response-api.service';

type QuoteAction = 'accept' | 'decline' | 'view';
const LOCAL_PENDING_QUOTE_RESPONSES_KEY = 'pathflow.quoteResponses.pending.v1';

type PendingQuoteResponse = {
  quoteId: string;
  stage: 'accepted' | 'declined';
  tenantId: string;
  updatedAt: string;
};

type QuoteViewLineItem = {
  type: string;
  code: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  lineSubtotal: number;
  taxAmount: number;
  lineTotal: number;
};

type QuoteViewPayload = {
  quoteId: string;
  quoteNumber: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  customerAddress: string;
  vehicle: string;
  businessName: string;
  businessEmail: string;
  businessPhone: string;
  businessAddress: string;
  businessLogoUrl: string;
  issueDate: string;
  dueDate: string;
  description: string;
  customerNote: string;
  subtotal: number;
  taxTotal: number;
  total: number;
  lineItems: QuoteViewLineItem[];
};

@Component({
  selector: 'app-quote-response',
  standalone: true,
  imports: [CommonModule, ],
  templateUrl: './quote-response.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./quote-response.component.scss']
})
export default class QuoteResponseComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly tenantContext = inject(TenantContextService);
  private readonly quoteResponseApi = inject(QuoteResponseApiService);
  private readonly remoteQuotePayload = signal<QuoteViewPayload | null>(null);
  private readonly selectedAction = signal<QuoteAction | null>(null);
  readonly responseState = signal<'idle' | 'submitting' | 'success' | 'error'>('idle');
  readonly responseSubmitting = computed(() => this.responseState() === 'submitting');

  readonly action = computed<QuoteAction>(() => {
    const selected = this.selectedAction();
    if (selected) return selected;
    const dataAction = String(this.route.snapshot.data['action'] || '').trim().toLowerCase();
    if (dataAction === 'accept') return 'accept';
    if (dataAction === 'decline') return 'decline';
    const value = String(this.route.snapshot.queryParamMap.get('action') || '').trim().toLowerCase();
    if (value === 'accept') return 'accept';
    if (value === 'decline') return 'decline';
    return 'view';
  });

  readonly quotePayload = computed<QuoteViewPayload | null>(() => this.decodeQuotePayload(this.route.snapshot.queryParamMap.get('quoteData')) || this.remoteQuotePayload());
  readonly quoteNumber = computed(() => this.quotePayload()?.quoteNumber || String(this.route.snapshot.queryParamMap.get('quoteNumber') || '').trim() || 'Quote');
  readonly customerName = computed(() => this.quotePayload()?.customerName || String(this.route.snapshot.queryParamMap.get('customerName') || '').trim() || 'Customer');
  readonly vehicle = computed(() => this.quotePayload()?.vehicle || String(this.route.snapshot.queryParamMap.get('vehicle') || '').trim() || 'Vehicle details pending');
  readonly businessName = computed(() => this.quotePayload()?.businessName || String(this.route.snapshot.queryParamMap.get('businessName') || '').trim() || 'Our team');

  readonly issueDate = computed(() => this.quotePayload()?.issueDate || '');
  readonly dueDate = computed(() => this.quotePayload()?.dueDate || '');
  readonly customerEmail = computed(() => this.quotePayload()?.customerEmail || '');
  readonly customerPhone = computed(() => this.quotePayload()?.customerPhone || '');
  readonly customerAddress = computed(() => this.quotePayload()?.customerAddress || '');
  readonly businessEmail = computed(() => this.quotePayload()?.businessEmail || '');
  readonly businessPhone = computed(() => this.quotePayload()?.businessPhone || '');
  readonly businessAddress = computed(() => this.quotePayload()?.businessAddress || '');
  readonly businessLogoUrl = computed(() => this.quotePayload()?.businessLogoUrl || '');
  readonly description = computed(() => this.quotePayload()?.description || '');
  readonly customerNote = computed(() => this.quotePayload()?.customerNote || '');

  readonly lineItems = computed<QuoteViewLineItem[]>(() => this.quotePayload()?.lineItems || []);
  readonly subtotal = computed(() => this.quotePayload()?.subtotal || this.roundCurrency(this.lineItems().reduce((sum, item) => sum + item.lineSubtotal, 0)));
  readonly taxTotal = computed(() => this.quotePayload()?.taxTotal || this.roundCurrency(this.lineItems().reduce((sum, item) => sum + item.taxAmount, 0)));
  readonly total = computed(() => this.quotePayload()?.total || this.roundCurrency(this.subtotal() + this.taxTotal()));

  readonly acceptUrl = computed(() => this.actionUrl('accept'));
  readonly declineUrl = computed(() => this.actionUrl('decline'));

  readonly title = computed(() => {
    if (this.responseSubmitting()) return 'Recording your response';
    if (this.responseState() === 'error') return 'Response not confirmed';
    if (this.action() === 'accept') return 'Quote Accepted';
    if (this.action() === 'decline') return 'Quote Declined';
    return 'Quote Ready';
  });

  readonly message = computed(() => {
    if (this.responseSubmitting()) return 'Please stay on this page while we record your response.';
    if (this.responseState() === 'error') return 'We could not confirm your response. Please try again.';
    if (this.action() === 'accept') {
      return `Thanks ${this.customerName()}, we received your approval. ${this.businessName()} will follow up with your invoice and scheduling details.`;
    }
    if (this.action() === 'decline') {
      return `Thanks ${this.customerName()}, we received your decline response. ${this.businessName()} can review options with you any time.`;
    }
    return `Review your quote details below. When you are ready, accept or decline right from this page.`;
  });

  readonly trackingMessage = signal('');

  constructor() {
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    if (this.action() !== 'view') {
      this.responseState.set('submitting');
      this.trackingMessage.set('Submitting your response...');
    }
    await this.loadRemoteQuoteSnapshot();
    if (this.action() !== 'view') await this.applyResponseTracking();
  }

  submitResponse(action: 'accept' | 'decline'): void {
    if (this.responseSubmitting() || this.responseState() === 'success') return;
    this.selectedAction.set(action);
    this.responseState.set('submitting');
    this.trackingMessage.set('Submitting your response...');
    void this.applyResponseTracking();
  }

  retryResponse(): void {
    const action = this.action();
    if (action === 'accept' || action === 'decline') this.submitResponse(action);
  }

  hasPendingAction(): boolean {
    return this.responseSubmitting();
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(event: BeforeUnloadEvent): void {
    if (!this.responseSubmitting()) return;
    event.preventDefault();
    event.returnValue = '';
  }

  private async loadRemoteQuoteSnapshot(): Promise<void> {
    if (this.decodeQuotePayload(this.route.snapshot.queryParamMap.get('quoteData'))) return;
    const quoteId = String(this.route.snapshot.queryParamMap.get('quoteId') || '').trim();
    const publicToken = String(this.route.snapshot.queryParamMap.get('publicToken') || '').trim();
    const tenantId = String(this.route.snapshot.queryParamMap.get('tenantId') || this.tenantContext.tenantId() || 'main').trim().toLowerCase() || 'main';
    if (!quoteId || !publicToken) return;

    try {
      const response = await firstValueFrom(this.quoteResponseApi.getSnapshot(quoteId, publicToken, tenantId));
      const raw = response?.item && typeof response.item === 'object' ? response.item as Record<string, unknown> : null;
      const quoteData = raw && raw['quoteData'] && typeof raw['quoteData'] === 'object'
        ? raw['quoteData'] as Record<string, unknown>
        : null;
      if (!quoteData) return;
      this.remoteQuotePayload.set(this.normalizeQuotePayload(quoteData));
    } catch {
      this.remoteQuotePayload.set(null);
    }
  }

  private async applyResponseTracking(): Promise<void> {
    const action = this.action();
    if (action === 'view') {
      this.trackingMessage.set('');
      return;
    }

    const quoteId = String(this.route.snapshot.queryParamMap.get('quoteId') || this.quotePayload()?.quoteId || '').trim();
    if (!quoteId) {
      this.responseState.set('error');
      this.trackingMessage.set('Quote ID is missing. Please contact the service team.');
      return;
    }

    const requestedTenant = String(this.route.snapshot.queryParamMap.get('tenantId') || '').trim().toLowerCase();
    const activeTenant = String(this.tenantContext.tenantId() || '').trim().toLowerCase() || 'main';
    const targetTenant = requestedTenant || activeTenant;
    const stage = action === 'accept' ? 'accepted' : 'declined';
    try {
      const response = await firstValueFrom(this.quoteResponseApi.capture({
        quoteId,
        publicToken: String(this.route.snapshot.queryParamMap.get('publicToken') || '').trim(),
        action,
        tenantId: targetTenant,
        quoteNumber: this.quoteNumber(),
        customerName: this.customerName(),
        vehicle: this.vehicle(),
        businessName: this.businessName()
      }));
      if (!response?.ok || response.stage !== stage) throw new Error('Quote response was not confirmed.');

      this.persistPendingResponse({
        quoteId,
        stage,
        tenantId: targetTenant,
        updatedAt: new Date().toISOString()
      });
      if (targetTenant === activeTenant) {
        try {
          this.invoicesData.setStage(
            quoteId,
            stage,
            `Customer ${action}ed quote from public link.`,
            'customer'
          );
        } catch {
          // The server confirmed the response; a local cache failure must not invite a duplicate submission.
        }
      }

      this.responseState.set('success');
      this.trackingMessage.set(`Quote status updated to ${action === 'accept' ? 'Accepted' : 'Declined'}.`);
    } catch {
      this.responseState.set('error');
      this.trackingMessage.set('Your response was not confirmed. Please try again.');
    }
  }

  private persistPendingResponse(entry: PendingQuoteResponse): void {
    try {
      const raw = localStorage.getItem(LOCAL_PENDING_QUOTE_RESPONSES_KEY);
      const parsed = raw ? (JSON.parse(raw) as PendingQuoteResponse[]) : [];
      const source = Array.isArray(parsed) ? parsed : [];
      const dedupe = `${entry.tenantId}|${entry.quoteId}`.toLowerCase();
      const next = source.filter(item => {
        const tenantId = String(item?.tenantId || '').trim().toLowerCase();
        const quoteId = String(item?.quoteId || '').trim().toLowerCase();
        return `${tenantId}|${quoteId}` !== dedupe;
      });
      next.push(entry);
      localStorage.setItem(LOCAL_PENDING_QUOTE_RESPONSES_KEY, JSON.stringify(next));
    } catch {
      // localStorage may be unavailable; skip local fallback persistence.
    }
  }

  private decodeQuotePayload(raw: string | null): QuoteViewPayload | null {
    const encoded = String(raw || '').trim();
    if (!encoded) return null;
    try {
      const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
      const json = typeof TextDecoder !== 'undefined' ? new TextDecoder().decode(bytes) : binary;
      const parsed = JSON.parse(json) as Partial<QuoteViewPayload>;
      return this.normalizeQuotePayload(parsed);
    } catch {
      return null;
    }
  }

  private normalizeQuotePayload(parsed: Partial<QuoteViewPayload> | Record<string, unknown> | null): QuoteViewPayload | null {
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      quoteId: String(parsed.quoteId || '').trim(),
      quoteNumber: String(parsed.quoteNumber || '').trim(),
      customerName: String(parsed.customerName || '').trim(),
      customerEmail: String(parsed.customerEmail || '').trim(),
      customerPhone: String(parsed.customerPhone || '').trim(),
      customerAddress: String(parsed.customerAddress || '').trim(),
      vehicle: String(parsed.vehicle || '').trim(),
      businessName: String(parsed.businessName || '').trim(),
      businessEmail: String(parsed.businessEmail || '').trim(),
      businessPhone: String(parsed.businessPhone || '').trim(),
      businessAddress: String(parsed.businessAddress || '').trim(),
      businessLogoUrl: String(parsed.businessLogoUrl || '').trim(),
      issueDate: String(parsed.issueDate || '').trim(),
      dueDate: String(parsed.dueDate || '').trim(),
      description: String(parsed.description || '').trim(),
      customerNote: String(parsed.customerNote || '').trim(),
      subtotal: this.asNumber(parsed.subtotal),
      taxTotal: this.asNumber(parsed.taxTotal),
      total: this.asNumber(parsed.total),
      lineItems: Array.isArray(parsed.lineItems) ? parsed.lineItems.map(item => this.mapLineItem(item)).filter(item => !!item.description || !!item.code || item.quantity > 0 || item.lineTotal > 0) : []
    };
  }

  private mapLineItem(value: unknown): QuoteViewLineItem {
    const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    return {
      type: String(row['type'] || '').trim().toLowerCase(),
      code: String(row['code'] || '').trim(),
      description: String(row['description'] || '').trim(),
      quantity: this.asNumber(row['quantity']),
      unitPrice: this.asNumber(row['unitPrice']),
      taxRate: this.asNumber(row['taxRate']),
      lineSubtotal: this.asNumber(row['lineSubtotal']),
      taxAmount: this.asNumber(row['taxAmount']),
      lineTotal: this.asNumber(row['lineTotal'])
    };
  }

  private asNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private roundCurrency(value: number): number {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
  }

  private actionUrl(action: 'accept' | 'decline' | 'view'): string {
    const path = action === 'accept' ? '/quote-accepted' : action === 'decline' ? '/quote-declined' : '/quote-response';
    const query = new URLSearchParams();
    for (const key of this.route.snapshot.queryParamMap.keys) {
      const value = this.route.snapshot.queryParamMap.get(key);
      if (value == null || value === '') continue;
      if (key === 'quoteData') {
        const safePayload = this.quotePayload();
        if (safePayload) query.set(key, this.encodeQuotePayload(safePayload));
      } else {
        query.set(key, value);
      }
    }
    query.set('action', action);
    return this.publicRouteUrl(path, query);
  }

  private encodeQuotePayload(payload: QuoteViewPayload): string {
    const json = JSON.stringify(payload);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private publicRouteUrl(path: string, query?: URLSearchParams): string {
    const normalizedPath = `/${String(path || '').replace(/^\/+/, '')}`;
    const base = typeof window !== 'undefined' && window.location?.origin ? String(window.location.origin).trim().replace(/\/+$/, '') : '';
    if (!base) {
      const suffix = query && query.toString() ? `?${query.toString()}` : '';
      return `${normalizedPath}${suffix}`;
    }
    const suffix = query && query.toString() ? `?${query.toString()}` : '';
    return `${base}${normalizedPath}${suffix}`;
  }
}
