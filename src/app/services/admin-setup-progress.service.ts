import { Injectable, computed, inject, signal } from '@angular/core';
import { catchError, firstValueFrom, of } from 'rxjs';
import { BrandSettingsService } from './brand-settings.service';
import { BusinessProfileService } from './business-profile.service';
import { PaymentGatewaySettingsService } from './payment-gateway-settings.service';
import { EmailApiService } from './email-api.service';
import { AccessAdminApiService } from './access-admin-api.service';
import { AppSettingsApiService } from './app-settings-api.service';
import { UserScopedSettingsService } from './user-scoped-settings.service';
import { CustomersApi } from './customers-api.service';
import { InventoryApiService } from './inventory-api.service';
import { AuthService } from '../auth/auth.service';

const SCHEDULE_SETTINGS_KEY = 'schedule.settings';
const SETUP_DONE_KEY = 'admin.setup.done.v1';
const SETUP_DISMISSED_KEY = 'admin.setup.dismissed.v1';

export type AdminSetupSection = 'branding' | 'schedule' | 'payments' | 'email' | 'users' | 'subscription' | 'customerImport';

export type AdminSetupItem = {
  id: string;
  label: string;
  section: AdminSetupSection;
  done: boolean;
};

@Injectable({ providedIn: 'root' })
export class AdminSetupProgressService {
  private readonly branding = inject(BrandSettingsService);
  private readonly businessProfile = inject(BusinessProfileService);
  private readonly paymentGateways = inject(PaymentGatewaySettingsService);
  private readonly emailApi = inject(EmailApiService);
  private readonly accessApi = inject(AccessAdminApiService);
  private readonly settingsApi = inject(AppSettingsApiService);
  private readonly userSettings = inject(UserScopedSettingsService);
  private readonly customersApi = inject(CustomersApi);
  private readonly inventoryApi = inject(InventoryApiService);
  private readonly auth = inject(AuthService);

  readonly loading = signal(false);
  readonly items = signal<AdminSetupItem[]>(this.defaultItems());
  readonly setupDone = signal(false);
  readonly dismissed = signal(false);
  private refreshInFlight: Promise<void> | null = null;
  private lastRefreshAt = 0;
  private static readonly REFRESH_MIN_INTERVAL_MS = 15000;

  readonly pendingItems = computed(() => this.items().filter(item => !item.done));
  readonly pendingCount = computed(() => this.pendingItems().length);
  readonly totalCount = computed(() => this.items().length);
  readonly isComplete = computed(() => this.pendingCount() === 0 || this.setupDone());
  readonly shouldPrompt = computed(() => !this.isComplete() && !this.dismissed());

  async refresh(force = false): Promise<void> {
    const now = Date.now();
    if (!force && this.refreshInFlight) return this.refreshInFlight;
    if (!force && now - this.lastRefreshAt < AdminSetupProgressService.REFRESH_MIN_INTERVAL_MS) {
      return;
    }

    const run = async (): Promise<void> => {
    this.loading.set(true);
    try {
      const [scheduleRaw, usersRes, emailTemplatesRes, senderRes, customerList, inventoryItemsRes, doneFlag, dismissedFlag] = await Promise.all([
        firstValueFrom(this.settingsApi.getValue<any>(SCHEDULE_SETTINGS_KEY)),
        firstValueFrom(this.accessApi.listUsers().pipe(catchError(() => of({ ok: false, items: [] as any[] } as any)))),
        firstValueFrom(this.emailApi.listTemplates().pipe(catchError(() => of({ templates: [] as any[] } as any)))),
        firstValueFrom(this.emailApi.getSenderConfig().pipe(catchError(() => of({ sender: { fromEmail: '' } } as any)))),
        firstValueFrom(this.customersApi.list().pipe(catchError(() => of([] as any[])))),
        firstValueFrom(this.inventoryApi.listItems().pipe(catchError(() => of({ items: [] as any[] } as any)))),
        firstValueFrom(this.userSettings.getValue<boolean>(SETUP_DONE_KEY)),
        firstValueFrom(this.userSettings.getValue<boolean>(SETUP_DISMISSED_KEY))
      ]);

      this.setupDone.set(!!doneFlag);
      this.dismissed.set(!!dismissedFlag);

      const profile = this.businessProfile.profile();
      const businessProfileDone = !!profile.companyName && !!profile.companyEmail && !!profile.companyPhone && !!profile.companyAddress;
      const logoDone = this.branding.hasCustomLogo();
      const scheduleDone = this.isScheduleReady(scheduleRaw);
      const paymentsDone = this.paymentGateways.providers().some(provider => provider.connected);
      const emailDone = Array.isArray(emailTemplatesRes?.templates) && emailTemplatesRes.templates.length > 0;
      const emailSenderDone = !!String(senderRes?.sender?.fromEmail || '').trim();
      const usersDone = Array.isArray(usersRes?.items) && usersRes.items.length > 0;
      const subscriptionDone = String(this.auth.billingStatus() || '').trim().toLowerCase() === 'active';
      const importedCustomers = Array.isArray(customerList) ? customerList.length : 0;
      const importedInventory = Array.isArray(inventoryItemsRes?.items) ? inventoryItemsRes.items.length : 0;
      const dataImportDone = importedCustomers > 0 || importedInventory > 0;

      const byId = new Map<string, boolean>([
        ['business-profile', businessProfileDone],
        ['logo', logoDone],
        ['business-hours', scheduleDone],
        ['payment-gateway', paymentsDone],
        ['email-sender', emailSenderDone],
        ['email-templates', emailDone],
        ['subscription', subscriptionDone],
        ['data-import', dataImportDone],
        ['user-access', usersDone]
      ]);

      this.items.update(current => current.map(item => ({ ...item, done: !!byId.get(item.id) })));
    } finally {
      this.loading.set(false);
      this.lastRefreshAt = Date.now();
      this.refreshInFlight = null;
    }
    };

    this.refreshInFlight = run();
    return this.refreshInFlight;
  }

  dismissPrompt(): void {
    this.dismissed.set(true);
    this.userSettings.setValue(SETUP_DISMISSED_KEY, true).subscribe({ error: () => {} });
  }

  clearDismissed(): void {
    this.dismissed.set(false);
    this.userSettings.deleteValue(SETUP_DISMISSED_KEY).subscribe({ error: () => {} });
  }

  markDone(): void {
    this.setupDone.set(true);
    this.userSettings.setValue(SETUP_DONE_KEY, true).subscribe({ error: () => {} });
  }

  unmarkDone(): void {
    this.setupDone.set(false);
    this.userSettings.deleteValue(SETUP_DONE_KEY).subscribe({ error: () => {} });
  }

  private isScheduleReady(value: any): boolean {
    if (!value || typeof value !== 'object') return false;
    const openHour = Number(value.openHour);
    const closeHour = Number(value.closeHour);
    const bays = Array.isArray(value.bays) ? value.bays : [];
    return Number.isFinite(openHour)
      && Number.isFinite(closeHour)
      && closeHour > openHour
      && bays.length > 0
      && bays.some((bay: any) => String(bay?.name || '').trim().length > 0);
  }

  private defaultItems(): AdminSetupItem[] {
    return [
      { id: 'business-profile', label: 'Complete Business Profile', section: 'branding', done: false },
      { id: 'logo', label: 'Upload Business Logo', section: 'branding', done: false },
      { id: 'business-hours', label: 'Set Business Hours', section: 'schedule', done: false },
      { id: 'payment-gateway', label: 'Connect Payment Gateway', section: 'payments', done: false },
      { id: 'email-sender', label: 'Configure Email Sender', section: 'email', done: false },
      { id: 'email-templates', label: 'Create Email Template', section: 'email', done: false },
      { id: 'subscription', label: 'Activate Subscription', section: 'subscription', done: false },
      { id: 'data-import', label: 'Import Customers or Inventory', section: 'customerImport', done: false },
      { id: 'user-access', label: 'Add Team User Access', section: 'users', done: false }
    ];
  }
}
