import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { IonContent } from '@ionic/angular/standalone';
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
  staffNote: string;
  subtotal: number;
  taxTotal: number;
  total: number;
  lineItems: QuoteViewLineItem[];
};

@Component({
  selector: 'app-quote-response',
  standalone: true,
  imports: [CommonModule, IonContent],
  templateUrl: './quote-response.component.html',
  styleUrls: ['./quote-response.component.scss']
})
export default class QuoteResponseComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly tenantContext = inject(TenantContextService);
  private readonly quoteResponseApi = inject(QuoteResponseApiService);

  readonly action = computed<QuoteAction>(() => {
    const dataAction = String(this.route.snapshot.data['action'] || '').trim().toLowerCase();
    if (dataAction === 'accept') return 'accept';
    if (dataAction === 'decline') return 'decline';
    const value = String(this.route.snapshot.queryParamMap.get('action') || '').trim().toLowerCase();
    if (value === 'accept') return 'accept';
    if (value === 'decline') return 'decline';
    return 'view';
  });

  readonly quotePayload = computed<QuoteViewPayload | null>(() => this.decodeQuotePayload(this.route.snapshot.queryParamMap.get('quoteData')));
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
  readonly staffNote = computed(() => this.quotePayload()?.staffNote || '');

  readonly lineItems = computed<QuoteViewLineItem[]>(() => this.quotePayload()?.lineItems || []);
  readonly subtotal = computed(() => this.quotePayload()?.subtotal || this.roundCurrency(this.lineItems().reduce((sum, item) => sum + item.lineSubtotal, 0)));
  readonly taxTotal = computed(() => this.quotePayload()?.taxTotal || this.roundCurrency(this.lineItems().reduce((sum, item) => sum + item.taxAmount, 0)));
  readonly total = computed(() => this.quotePayload()?.total || this.roundCurrency(this.subtotal() + this.taxTotal()));

  readonly acceptUrl = computed(() => this.actionUrl('accept'));
  readonly declineUrl = computed(() => this.actionUrl('decline'));

  readonly title = computed(() => {
    if (this.action() === 'accept') return 'Quote Accepted';
    if (this.action() === 'decline') return 'Quote Declined';
    return 'Quote Ready';
  });

  readonly message = computed(() => {
    if (this.action() === 'accept') {
      return `Thanks ${this.customerName()}, we received your approval. ${this.businessName()} will follow up with your invoice and scheduling details.`;
    }
    if (this.action() === 'decline') {
      return `Thanks ${this.customerName()}, we received your decline response. ${this.businessName()} can review options with you any time.`;
    }
    return `Review your quote details below. When you are ready, accept or decline right from this page.`;
  });

  readonly trackingMessage = signal('Recording your response...');

  constructor() {
    this.applyResponseTracking();
  }

  private async applyResponseTracking(): Promise<void> {
    const action = this.action();
    if (action === 'view') {
      this.trackingMessage.set('');
      return;
    }

    const quoteId = String(this.route.snapshot.queryParamMap.get('quoteId') || this.quotePayload()?.quoteId || '').trim();
    if (!quoteId) {
      this.trackingMessage.set('Quote response captured.');
      return;
    }

    const requestedTenant = String(this.route.snapshot.queryParamMap.get('tenantId') || '').trim().toLowerCase();
    const activeTenant = String(this.tenantContext.tenantId() || '').trim().toLowerCase() || 'main';
    const targetTenant = requestedTenant || activeTenant;
    const stage = action === 'accept' ? 'accepted' : 'declined';
    this.persistPendingResponse({
      quoteId,
      stage,
      tenantId: targetTenant,
      updatedAt: new Date().toISOString()
    });

    try {
      await firstValueFrom(this.quoteResponseApi.capture({
        quoteId,
        action,
        tenantId: targetTenant,
        quoteNumber: this.quoteNumber(),
        customerName: this.customerName(),
        vehicle: this.vehicle(),
        businessName: this.businessName()
      }));

      if (targetTenant !== activeTenant) {
        this.tenantContext.setTenantOverride(targetTenant);
      }
      this.invoicesData.setStage(
        quoteId,
        stage,
        `Customer ${action}ed quote from public link.`,
        'customer'
      );
      if (targetTenant !== activeTenant) {
        this.tenantContext.setTenantOverride(activeTenant);
      }

      this.trackingMessage.set(`Quote status updated to ${action === 'accept' ? 'Accepted' : 'Declined'}.`);
    } catch {
      this.trackingMessage.set('We captured your response. If status has not updated yet, please refresh and try again.');
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
        staffNote: String(parsed.staffNote || '').trim(),
        subtotal: this.asNumber(parsed.subtotal),
        taxTotal: this.asNumber(parsed.taxTotal),
        total: this.asNumber(parsed.total),
        lineItems: Array.isArray(parsed.lineItems) ? parsed.lineItems.map(item => this.mapLineItem(item)).filter(item => !!item.description || !!item.code || item.quantity > 0 || item.lineTotal > 0) : []
      };
    } catch {
      return null;
    }
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
      if (value != null && value !== '') query.set(key, value);
    }
    query.set('action', action);
    return this.publicRouteUrl(path, query);
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
