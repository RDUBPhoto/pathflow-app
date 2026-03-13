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

  readonly quoteNumber = computed(() => String(this.route.snapshot.queryParamMap.get('quoteNumber') || '').trim() || 'Quote');
  readonly customerName = computed(() => String(this.route.snapshot.queryParamMap.get('customerName') || '').trim() || 'Customer');
  readonly vehicle = computed(() => String(this.route.snapshot.queryParamMap.get('vehicle') || '').trim() || 'Vehicle details pending');
  readonly businessName = computed(() => String(this.route.snapshot.queryParamMap.get('businessName') || '').trim() || 'Our team');

  readonly title = computed(() => {
    if (this.action() === 'accept') return 'Quote Accepted';
    if (this.action() === 'decline') return 'Quote Declined';
    return 'Quote Received';
  });

  readonly message = computed(() => {
    if (this.action() === 'accept') {
      return `Thanks ${this.customerName()}, we received your approval. ${this.businessName()} will follow up with your invoice and scheduling details.`;
    }
    if (this.action() === 'decline') {
      return `Thanks ${this.customerName()}, we received your decline response. ${this.businessName()} can review options with you any time.`;
    }
    return `We received your quote response link click. ${this.businessName()} will continue the next step with you.`;
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

    const quoteId = String(this.route.snapshot.queryParamMap.get('quoteId') || '').trim();
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

      // Keep local fallback update for same-browser testing.
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
}
