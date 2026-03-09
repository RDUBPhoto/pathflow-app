import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { IonContent } from '@ionic/angular/standalone';
import { InvoicesDataService } from '../../services/invoices-data.service';
import { TenantContextService } from '../../services/tenant-context.service';

type QuoteAction = 'accept' | 'decline' | 'view';

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

  readonly trackingMessage = signal('');

  constructor() {
    this.applyResponseTracking();
  }

  private applyResponseTracking(): void {
    const action = this.action();
    if (action === 'view') return;

    const quoteId = String(this.route.snapshot.queryParamMap.get('quoteId') || '').trim();
    if (!quoteId) {
      this.trackingMessage.set('Quote response captured.');
      return;
    }

    const requestedTenant = String(this.route.snapshot.queryParamMap.get('tenantId') || '').trim().toLowerCase();
    const activeTenant = String(this.tenantContext.tenantId() || '').trim().toLowerCase() || 'main';
    const targetTenant = requestedTenant || activeTenant;

    if (targetTenant !== activeTenant) {
      this.tenantContext.setTenantOverride(targetTenant);
    }

    const updated = this.invoicesData.setStage(
      quoteId,
      action === 'accept' ? 'accepted' : 'declined',
      `Customer ${action}ed quote from public link.`
    );

    if (targetTenant !== activeTenant) {
      this.tenantContext.setTenantOverride(activeTenant);
    }

    this.trackingMessage.set(
      updated
        ? `Quote status updated to ${action === 'accept' ? 'Accepted' : 'Declined'}.`
        : 'Quote response captured.'
    );
  }
}
