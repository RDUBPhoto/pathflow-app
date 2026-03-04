import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../auth/auth.service';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { Customer, CustomersApi } from '../../services/customers-api.service';
import { InvoicesDataService } from '../../services/invoices-data.service';
import { MentionableUser, NotificationsApiService } from '../../services/notifications-api.service';

type InvoiceTemplate = {
  id: string;
  name: string;
  description: string;
  includes: string[];
};

type CustomerPrefill = {
  name: string;
  email: string;
  phone: string;
  vehicle: string;
};

type StatusTone = 'neutral' | 'success' | 'error';

const PREBUILT_TEMPLATES: InvoiceTemplate[] = [
  {
    id: 'parts-invoice',
    name: 'Parts Invoice',
    description: 'Combined parts + labor invoice for full service jobs.',
    includes: ['Parts line items', 'Labor line items', 'Tax + fees']
  },
  {
    id: 'parts-only',
    name: 'Parts Only',
    description: 'Retail or internal parts invoice with no labor section.',
    includes: ['Parts line items', 'Tax + fees', 'Core charges']
  },
  {
    id: 'labor-only',
    name: 'Labor only',
    description: 'Labor-focused invoice for diagnostics and service time.',
    includes: ['Labor ops', 'Shop supplies', 'Notes section']
  },
  {
    id: 'alignment',
    name: 'Alignment',
    description: 'Quick alignment invoice with before/after notes area.',
    includes: ['Alignment package', 'Camber/caster notes', 'Road test notes']
  },
  {
    id: 'credit-memo',
    name: 'Credit Memo',
    description: 'Credit or adjustment invoice tied to a prior charge.',
    includes: ['Reference invoice', 'Credit reason', 'Refund total']
  },
  {
    id: 'other',
    name: 'Other',
    description: 'Start from a minimal invoice shell and fill manually.',
    includes: ['Header + customer', 'Custom line items', 'Manual totals']
  }
];

@Component({
  selector: 'app-invoices-new',
  standalone: true,
  imports: [
    CommonModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    PageBackButtonComponent,
    CompanySwitcherComponent,
    UserMenuComponent
  ],
  templateUrl: './invoices-new.component.html',
  styleUrls: ['./invoices-new.component.scss']
})
export default class InvoicesNewComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly notificationsApi = inject(NotificationsApiService);
  private readonly customersApi = inject(CustomersApi);
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly auth = inject(AuthService);

  private pendingCustomerId = '';
  private readonly customerPrefill = signal<CustomerPrefill | null>(null);

  readonly templates = PREBUILT_TEMPLATES;
  readonly status = signal('');
  readonly statusTone = signal<StatusTone>('neutral');
  readonly customerQuery = signal('');
  readonly customers = signal<Customer[]>([]);
  readonly customersLoading = signal(false);
  readonly customersError = signal('');
  readonly selectedCustomer = signal<Customer | null>(null);
  readonly mentionQuery = signal('');
  readonly mentionUsers = signal<MentionableUser[]>([]);
  readonly mentionsLoading = signal(false);
  readonly mentionsError = signal('');
  readonly creatingInvoice = signal(false);
  readonly selectedMentionsMap = signal<Record<string, MentionableUser>>({});
  readonly selectedMentions = computed(() => Object.values(this.selectedMentionsMap()));
  readonly hasSelectedCustomer = computed(() => !!this.selectedCustomer());
  readonly fromCustomerProfile = computed(() => !!this.customerPrefill());

  readonly filteredMentionUsers = computed(() => {
    const query = this.mentionQuery().trim().toLowerCase();
    const selfEmail = (this.auth.user()?.email || '').trim().toLowerCase();
    return this.mentionUsers().filter(user => {
      if (selfEmail && user.email.trim().toLowerCase() === selfEmail) return false;
      if (!query) return true;
      const haystack = `${user.displayName} ${user.email}`.toLowerCase();
      return haystack.includes(query);
    });
  });

  readonly filteredCustomers = computed(() => {
    const query = this.customerQuery().trim().toLowerCase();
    const source = this.customers();
    if (!query) return source;
    return source.filter(customer => {
      const haystack = [
        this.customerDisplayName(customer),
        customer.email || '',
        customer.phone || '',
        this.customerVehicleSummary(customer)
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  });

  readonly selectedCustomerName = computed(() => this.customerDisplayName(this.selectedCustomer()));
  readonly selectedCustomerEmail = computed(() => {
    const value = this.selectedCustomer()?.email || this.customerPrefill()?.email || '';
    return value.trim() || 'No email on file';
  });
  readonly selectedCustomerPhone = computed(() => {
    const value = this.selectedCustomer()?.phone || this.customerPrefill()?.phone || '';
    return value.trim() || 'No phone on file';
  });
  readonly selectedCustomerVehicle = computed(() => {
    const fallback = this.customerPrefill()?.vehicle || '';
    const vehicle = this.customerVehicleSummary(this.selectedCustomer()) || fallback;
    return vehicle.trim() || 'Vehicle not set';
  });

  constructor() {
    this.loadMentionableUsers();
    this.loadCustomers();
    this.route.queryParamMap.subscribe(params => {
      this.pendingCustomerId = (params.get('customerId') || '').trim();
      const prefill: CustomerPrefill = {
        name: (params.get('customerName') || '').trim(),
        email: (params.get('customerEmail') || '').trim(),
        phone: (params.get('customerPhone') || '').trim(),
        vehicle: (params.get('customerVehicle') || '').trim()
      };
      const hasPrefill = Object.values(prefill).some(value => !!value);
      this.customerPrefill.set(hasPrefill ? prefill : null);
      this.trySelectPendingCustomer();
    });
  }

  async selectTemplate(template: InvoiceTemplate): Promise<void> {
    const customer = this.selectedCustomer();
    if (!customer) {
      this.setStatus('Select a customer before creating an invoice.', 'error');
      return;
    }
    if (this.creatingInvoice()) return;

    this.creatingInvoice.set(true);
    this.setStatus('');

    const customerName = this.customerDisplayName(customer);
    const createdInvoice = this.invoicesData.createDraftInvoice({
      customerId: String(customer.id || '').trim() || undefined,
      customerName,
      customerEmail: String(customer.email || '').trim() || undefined,
      vehicle: this.customerVehicleSummary(customer) || this.selectedCustomerVehicle(),
      template: template.name
    });

    try {
      let mentionStatus = '';
      const mentions = this.selectedMentions();

      if (mentions.length) {
        const actor = this.auth.user()?.displayName || this.auth.user()?.email || 'A teammate';
        const route = `/invoices/${encodeURIComponent(createdInvoice.id)}`;
        const title = `${actor} mentioned you in ${createdInvoice.invoiceNumber}`;
        const message = `${customerName} invoice was created from ${template.name} and you were tagged to review it.`;

        const requests = mentions.map(user =>
          firstValueFrom(this.notificationsApi.createMention({
            targetUserId: user.id || undefined,
            targetEmail: user.email || undefined,
            targetDisplayName: user.displayName || undefined,
            title,
            message,
            route,
            entityType: 'invoice',
            metadata: {
              invoiceId: createdInvoice.id,
              invoiceNumber: createdInvoice.invoiceNumber,
              templateId: template.id,
              templateName: template.name,
              customerId: String(customer.id || '').trim() || undefined,
              customerName
            }
          }))
        );

        const results = await Promise.allSettled(requests);
        const successCount = results.filter(result => result.status === 'fulfilled').length;
        const failureCount = results.length - successCount;

        if (failureCount === 0) {
          mentionStatus = `${successCount} mention notification${successCount === 1 ? '' : 's'} sent.`;
        } else if (successCount > 0) {
          mentionStatus = `${successCount} mention${successCount === 1 ? '' : 's'} sent, ${failureCount} failed.`;
        } else {
          mentionStatus = 'Could not send mention notifications.';
        }
      }

      this.setStatus(
        mentionStatus
          ? `${createdInvoice.invoiceNumber} created in Draft. ${mentionStatus}`
          : `${createdInvoice.invoiceNumber} created in Draft.`,
        'success'
      );

      await this.router.navigate(['/invoices'], {
        queryParams: { created: createdInvoice.id }
      });
    } catch {
      this.setStatus('Could not create invoice.', 'error');
    } finally {
      this.creatingInvoice.set(false);
    }
  }

  setCustomerQuery(value: string): void {
    this.customerQuery.set(value || '');
  }

  selectCustomer(customer: Customer): void {
    this.selectedCustomer.set(customer);
    this.setStatus('');
  }

  clearSelectedCustomer(): void {
    this.selectedCustomer.set(null);
    this.setStatus('');
  }

  isSelectedCustomer(customer: Customer): boolean {
    const selected = this.selectedCustomer();
    if (!selected) return false;
    const selectedId = String(selected.id || '').trim();
    const customerId = String(customer.id || '').trim();
    if (selectedId && customerId) return selectedId === customerId;
    return this.customerDisplayName(selected) === this.customerDisplayName(customer);
  }

  setMentionQuery(value: string): void {
    this.mentionQuery.set(value);
  }

  toggleMentionUser(user: MentionableUser): void {
    const key = this.userKey(user);
    if (!key) return;
    this.selectedMentionsMap.update(current => {
      const next = { ...current };
      if (next[key]) {
        delete next[key];
      } else {
        next[key] = user;
      }
      return next;
    });
  }

  isMentioned(user: MentionableUser): boolean {
    const key = this.userKey(user);
    return !!(key && this.selectedMentionsMap()[key]);
  }

  removeMention(user: MentionableUser): void {
    const key = this.userKey(user);
    if (!key) return;
    this.selectedMentionsMap.update(current => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  trackTemplate(_index: number, template: InvoiceTemplate): string {
    return template.id;
  }

  trackCustomer(index: number, customer: Customer): string {
    const id = String(customer.id || '').trim();
    if (id) return id;
    const email = String(customer.email || '').trim().toLowerCase();
    if (email) return email;
    return `${this.customerDisplayName(customer)}-${index}`;
  }

  trackMentionUser(index: number, user: MentionableUser): string {
    return this.userKey(user) || `mention-${index}`;
  }

  customerDisplayName(customer: Customer | null | undefined): string {
    if (!customer) return 'Customer';
    const name = String(customer.name || '').trim();
    if (name) return name;
    const firstName = String(customer.firstName || '').trim();
    const lastName = String(customer.lastName || '').trim();
    const fallback = `${firstName} ${lastName}`.trim();
    return fallback || 'Customer';
  }

  customerVehicleSummary(customer: Customer | null | undefined): string {
    if (!customer) return '';
    const summary = [customer.vehicleYear, customer.vehicleMake, customer.vehicleModel, customer.vehicleTrim]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .join(' ');
    return summary || String(customer.vehicleMake || '').trim();
  }

  private setStatus(message: string, tone: StatusTone = 'neutral'): void {
    this.status.set(message);
    this.statusTone.set(tone);
  }

  private loadCustomers(): void {
    this.customersLoading.set(true);
    this.customersError.set('');
    this.customersApi.list().subscribe({
      next: items => {
        const sorted = [...(Array.isArray(items) ? items : [])].sort((a, b) =>
          this.customerDisplayName(a).localeCompare(this.customerDisplayName(b))
        );
        this.customers.set(sorted);
        this.customersLoading.set(false);
        this.trySelectPendingCustomer();
      },
      error: () => {
        this.customersError.set('Could not load customers.');
        this.customersLoading.set(false);
        this.trySelectPendingCustomer();
      }
    });
  }

  private trySelectPendingCustomer(): void {
    if (this.pendingCustomerId) {
      const byId = this.customers().find(item => String(item.id || '').trim() === this.pendingCustomerId);
      if (byId) {
        this.selectedCustomer.set(byId);
        this.pendingCustomerId = '';
        return;
      }
    }

    const selected = this.selectedCustomer();
    if (selected?.id) return;

    const fallback = this.customerPrefill();
    if (!fallback) return;

    const matched = this.findCustomerByPrefill(fallback);
    if (matched) {
      this.selectedCustomer.set(matched);
      return;
    }

    if (selected) return;

    const fallbackName = fallback.name || fallback.email || fallback.phone || 'Customer';
    this.selectedCustomer.set({
      id: '',
      name: fallbackName,
      email: fallback.email || undefined,
      phone: fallback.phone || undefined,
      vehicleMake: fallback.vehicle || undefined
    });
  }

  private findCustomerByPrefill(prefill: CustomerPrefill): Customer | null {
    const email = prefill.email.trim().toLowerCase();
    const name = prefill.name.trim().toLowerCase();
    if (!email && !name) return null;

    const byEmail = email
      ? this.customers().find(item => String(item.email || '').trim().toLowerCase() === email)
      : null;
    if (byEmail) return byEmail;

    const byName = name
      ? this.customers().find(item => this.customerDisplayName(item).trim().toLowerCase() === name)
      : null;
    return byName || null;
  }

  private loadMentionableUsers(): void {
    this.mentionsLoading.set(true);
    this.mentionsError.set('');
    this.notificationsApi.listMentionableUsers().subscribe({
      next: res => {
        this.mentionUsers.set(Array.isArray(res.items) ? res.items : []);
        this.mentionsLoading.set(false);
      },
      error: () => {
        this.mentionsError.set('Could not load users to mention.');
        this.mentionsLoading.set(false);
      }
    });
  }

  private userKey(user: MentionableUser): string {
    return String(user.id || user.email || '').trim().toLowerCase();
  }
}
