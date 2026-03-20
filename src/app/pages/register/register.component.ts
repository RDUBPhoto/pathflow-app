import { Component, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonButton,
  IonContent,
  IonInput,
  IonItem,
  IonLabel,
  IonSpinner
} from '@ionic/angular/standalone';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription, finalize, firstValueFrom } from 'rxjs';
import { AuthService } from '../../auth/auth.service';
import { TenantContextService } from '../../services/tenant-context.service';
import { BusinessProfileService } from '../../services/business-profile.service';
import { AddressLookupService, AddressSuggestion } from '../../services/address-lookup.service';
import { formatUsPhoneInput, phoneDigits } from '../../utils/phone-format';

@Component({
  selector: 'app-register',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonContent,
    IonItem,
    IonLabel,
    IonInput,
    IonButton,
    IonSpinner
  ],
  templateUrl: './register.component.html',
  styleUrls: ['./register.component.scss']
})
export default class RegisterComponent implements OnDestroy {
  readonly auth = inject(AuthService);
  private readonly tenantContext = inject(TenantContextService);
  private readonly businessProfile = inject(BusinessProfileService);
  private readonly addressLookup = inject(AddressLookupService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly saving = signal(false);
  readonly error = signal('');
  readonly locationName = signal('Pathflow HQ');
  readonly businessName = signal('');
  readonly businessEmail = signal('');
  readonly businessPhone = signal('');
  readonly businessAddress = signal('');
  readonly businessAddressSuggestions = signal<AddressSuggestion[]>([]);
  readonly businessAddressSearching = signal(false);
  readonly businessAddressNoMatches = signal(false);
  readonly hasMultipleLocations = signal<'single' | 'multiple'>('single');
  readonly extraLocationNames = signal<string[]>([]);
  readonly selectedPlan = signal<'trial' | 'monthly' | 'annual'>('trial');
  readonly billingMode = signal(false);
  readonly cardholderName = signal('');
  readonly cardNumber = signal('');
  readonly expiryMonth = signal('');
  readonly expiryYear = signal('');
  readonly cvc = signal('');
  readonly postalCode = signal('');
  readonly redirectTo = signal('/dashboard');
  readonly monthlyPrice = signal(149);
  readonly annualPrice = signal(1490);
  private businessAddressLookupSub: Subscription | null = null;
  private businessAddressSearchTimer: ReturnType<typeof setTimeout> | null = null;

  readonly isBillingUpdateMode = computed(() => this.auth.isAccessLocked() || this.billingMode());
  readonly showTrialOption = computed(() => !this.isBillingUpdateMode());
  readonly requiresBilling = computed(() => this.isBillingUpdateMode() || this.selectedPlan() !== 'trial');
  readonly planCycleForBilling = computed<'monthly' | 'annual'>(() => this.selectedPlan() === 'annual' ? 'annual' : 'monthly');
  readonly annualSavingsPercent = computed(() => {
    const monthly = this.monthlyPrice();
    const annual = this.annualPrice();
    if (monthly <= 0 || annual <= 0) return 0;
    const yearlyMonthly = monthly * 12;
    const savings = Math.max(0, yearlyMonthly - annual);
    return Math.round((savings / yearlyMonthly) * 100);
  });
  readonly trialEndsDisplay = computed(() => this.toDisplayDate(this.auth.trialEndsAt()));
  readonly billingProvided = computed(() => (
    this.cardholderName().trim().length > 0 ||
    this.digitsOnly(this.cardNumber()).length > 0 ||
    this.digitsOnly(this.expiryMonth()).length > 0 ||
    this.digitsOnly(this.expiryYear()).length > 0 ||
    this.digitsOnly(this.cvc()).length > 0 ||
    this.digitsOnly(this.postalCode()).length > 0
  ));

  readonly isSandboxCard = computed(() => {
    const cardDigits = this.digitsOnly(this.cardNumber());
    if (!/^9{5,}$/.test(cardDigits)) return false;

    const monthDigits = this.digitsOnly(this.expiryMonth());
    const yearDigits = this.digitsOnly(this.expiryYear());
    const cvcDigits = this.digitsOnly(this.cvc());
    const postalDigits = this.digitsOnly(this.postalCode());

    const optionalAllNines = (value: string): boolean => !value || /^9+$/.test(value);
    return (
      optionalAllNines(monthDigits) &&
      optionalAllNines(yearDigits) &&
      optionalAllNines(cvcDigits) &&
      optionalAllNines(postalDigits)
    );
  });

  readonly billingValid = computed(() => {
    if (this.isSandboxCard()) return true;

    const cardholder = this.cardholderName().trim();
    const cardDigits = this.digitsOnly(this.cardNumber());
    const monthDigits = this.digitsOnly(this.expiryMonth());
    const yearDigits = this.digitsOnly(this.expiryYear());
    const cvcDigits = this.digitsOnly(this.cvc());
    const postalDigits = this.digitsOnly(this.postalCode());

    if (cardholder.length < 2) return false;
    if (cardDigits.length < 13 || cardDigits.length > 19) return false;
    if (monthDigits.length < 1 || monthDigits.length > 2) return false;
    if (yearDigits.length < 2 || yearDigits.length > 4) return false;
    if (cvcDigits.length < 3 || cvcDigits.length > 4) return false;
    if (postalDigits.length < 5) return false;

    const month = Number(monthDigits);
    if (!Number.isFinite(month) || month < 1 || month > 12) return false;

    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    const parsedYear = yearDigits.length === 2 ? Number(`20${yearDigits}`) : Number(yearDigits);
    if (!Number.isFinite(parsedYear) || parsedYear < currentYear || parsedYear > currentYear + 25) return false;
    if (parsedYear === currentYear && month < currentMonth) return false;

    return true;
  });

  readonly canSubmit = computed(() =>
    !this.saving() &&
    (this.isBillingUpdateMode() || this.auth.canBootstrapRegistration()) &&
    (this.isBillingUpdateMode() || this.registrationLocationsValid()) &&
    (this.isBillingUpdateMode() || this.registrationBusinessValid()) &&
    (!this.requiresBilling() || this.billingValid())
  );
  readonly registrationLocationsValid = computed(() => {
    const base = this.locationName().trim();
    if (base.length < 3) return false;
    if (this.hasMultipleLocations() !== 'multiple') return true;
    const extras = this.extraLocationNames().map(value => String(value || '').trim());
    if (!extras.length) return false;
    return extras.every(value => value.length >= 3);
  });
  readonly registrationLocationNames = computed(() => {
    const base = this.locationName().trim();
    const extras = this.extraLocationNames()
      .map(value => String(value || '').trim())
      .filter(Boolean);
    if (this.hasMultipleLocations() !== 'multiple') {
      return base ? [base] : [];
    }
    return [base, ...extras].filter(Boolean);
  });
  readonly registrationBusinessValid = computed(() => {
    if (this.isBillingUpdateMode()) return true;
    if (this.businessName().trim().length < 2) return false;
    const email = this.businessEmail().trim();
    if (!email || !this.isValidEmail(email)) return false;
    if (this.businessPhone().trim().length < 7) return false;
    if (this.businessAddress().trim().length < 6) return false;
    return true;
  });

  readonly submitLabel = computed(() => {
    if (this.requiresBilling()) {
      return this.planCycleForBilling() === 'annual' ? 'Start Annual Plan' : 'Start Monthly Plan';
    }
    return 'Start 7-Day Free Trial';
  });

  constructor() {
    const currentRoutePath = (this.route.snapshot.routeConfig?.path || '').toLowerCase();
    this.billingMode.set(currentRoutePath === 'billing');
    if (this.billingMode()) {
      this.selectedPlan.set(this.auth.planCycle() === 'annual' ? 'annual' : 'monthly');
    }

    this.route.queryParamMap.subscribe(params => {
      this.redirectTo.set(this.normalizeRedirect(params.get('redirect')));
      const mode = (params.get('mode') || '').trim().toLowerCase();
      if (mode === 'billing') {
        this.billingMode.set(true);
        this.selectedPlan.set(this.auth.planCycle() === 'annual' ? 'annual' : 'monthly');
      }
      const queryPlan = (params.get('plan') || '').trim().toLowerCase();
      if (queryPlan === 'annual' || queryPlan === 'monthly' || queryPlan === 'trial') {
        if (this.isBillingUpdateMode() && queryPlan === 'trial') return;
        this.selectedPlan.set(queryPlan as 'trial' | 'monthly' | 'annual');
      }
      const userEmail = String(this.auth.user()?.email || '').trim();
      if (userEmail && !this.businessEmail().trim()) {
        this.businessEmail.set(userEmail);
      }
    });

    effect(() => {
      if (!this.auth.initialized()) return;
      if (!this.auth.isAuthenticated()) return;
      if (this.billingMode()) return;
      if (this.auth.needsRegistration() || this.auth.isAccessLocked()) return;
      void this.router.navigateByUrl(this.redirectTo(), { replaceUrl: true });
    });

    effect(() => {
      if (!this.auth.isAccessLocked()) return;
      this.billingMode.set(true);
      this.selectedPlan.set(this.auth.planCycle() === 'annual' ? 'annual' : 'monthly');
      const defaultLocationId = this.auth.defaultLocationId();
      const location = this.auth.locations().find(item => item.id === defaultLocationId) || this.auth.locations()[0];
      if (location?.name) {
        this.locationName.set(location.name);
        if (!this.businessName().trim()) {
          this.businessName.set(location.name);
        }
      }
    });
  }

  async submitRegistration(): Promise<void> {
    if (!this.canSubmit()) return;

    this.saving.set(true);
    this.error.set('');
    const selectedCycle = this.planCycleForBilling();
    const billingPayload = this.requiresBilling() ? this.buildBillingPayload() : null;
    const response = this.isBillingUpdateMode()
      ? await this.auth.updateBilling(billingPayload as ReturnType<RegisterComponent['buildBillingPayload']>, selectedCycle)
      : await this.auth.registerWorkspace(
          this.registrationLocationNames(),
          billingPayload || undefined,
          selectedCycle
        );
    if (!response.ok) {
      this.error.set(response.error || 'Unable to complete registration.');
      this.saving.set(false);
      return;
    }

    const defaultLocation = this.auth.defaultLocationId();
    if (defaultLocation) {
      this.tenantContext.setTenantOverride(defaultLocation);
    }

    if (!this.isBillingUpdateMode()) {
      try {
        await firstValueFrom(this.businessProfile.save({
          companyName: this.businessName().trim() || this.locationName().trim(),
          companyEmail: this.businessEmail().trim() || this.auth.user()?.email || '',
          companyPhone: this.businessPhone().trim(),
          companyAddress: this.businessAddress().trim()
        }));
      } catch {
        // Non-blocking: registration already succeeded.
      }
    }

    this.saving.set(false);
    await this.router.navigateByUrl(this.redirectTo(), { replaceUrl: true });
  }

  ngOnDestroy(): void {
    this.businessAddressLookupSub?.unsubscribe();
    if (this.businessAddressSearchTimer) {
      clearTimeout(this.businessAddressSearchTimer);
      this.businessAddressSearchTimer = null;
    }
  }

  useDifferentAccount(): void {
    this.auth.signOut('/login');
  }

  setPlanCycle(cycle: 'trial' | 'monthly' | 'annual'): void {
    if (this.isBillingUpdateMode() && cycle === 'trial') return;
    this.selectedPlan.set(cycle);
  }

  setLocationMode(mode: 'single' | 'multiple'): void {
    this.hasMultipleLocations.set(mode);
    if (mode !== 'multiple') {
      this.extraLocationNames.set([]);
    } else if (!this.extraLocationNames().length) {
      this.extraLocationNames.set(['']);
    }
  }

  addLocationField(): void {
    this.extraLocationNames.set([...this.extraLocationNames(), '']);
  }

  removeLocationField(index: number): void {
    const current = this.extraLocationNames();
    if (index < 0 || index >= current.length) return;
    this.extraLocationNames.set(current.filter((_, idx) => idx !== index));
  }

  updateLocationField(index: number, value: string): void {
    const current = [...this.extraLocationNames()];
    if (index < 0 || index >= current.length) return;
    current[index] = value ?? '';
    this.extraLocationNames.set(current);
  }

  onBusinessPhoneInput(value: string | null | undefined): void {
    this.businessPhone.set(formatUsPhoneInput(value));
  }

  onBusinessAddressChange(value: string | null | undefined): void {
    this.businessAddress.set(String(value || ''));
    this.businessAddressNoMatches.set(false);
    this.queueBusinessAddressLookup(this.businessAddress());
  }

  onBusinessAddressBlur(): void {
    const normalized = this.businessAddress().trim().toLowerCase();
    if (normalized) {
      const exact = this.businessAddressSuggestions().find(item => item.display.trim().toLowerCase() === normalized);
      if (exact) this.selectBusinessAddressSuggestion(exact);
    }
    setTimeout(() => this.businessAddressSuggestions.set([]), 120);
  }

  selectBusinessAddressSuggestion(item: AddressSuggestion): void {
    this.businessAddress.set(item.display);
    this.businessAddressSuggestions.set([]);
    this.businessAddressNoMatches.set(false);
  }

  private normalizeRedirect(path: string | null): string {
    const value = (path || '').trim();
    if (!value.startsWith('/')) return '/dashboard';
    if (value.startsWith('/.auth/')) return '/dashboard';
    if (value.startsWith('/register')) return '/dashboard';
    return value;
  }

  private digitsOnly(value: unknown): string {
    return phoneDigits(value);
  }

  private buildBillingPayload(): {
    cardholderName: string;
    cardNumber: string;
    expiryMonth: string;
    expiryYear: string;
    cvc: string;
    postalCode: string;
    sandboxBypass: boolean;
  } {
    return {
      cardholderName: this.cardholderName().trim(),
      cardNumber: this.digitsOnly(this.cardNumber()),
      expiryMonth: this.digitsOnly(this.expiryMonth()),
      expiryYear: this.digitsOnly(this.expiryYear()),
      cvc: this.digitsOnly(this.cvc()),
      postalCode: this.digitsOnly(this.postalCode()),
      sandboxBypass: this.isSandboxCard()
    };
  }

  private toDisplayDate(value: string): string {
    const parsed = new Date(String(value || '').trim());
    if (Number.isNaN(parsed.getTime())) return '';
    return parsed.toLocaleDateString();
  }

  private isValidEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
  }

  private queueBusinessAddressLookup(raw: string): void {
    if (this.businessAddressSearchTimer) {
      clearTimeout(this.businessAddressSearchTimer);
      this.businessAddressSearchTimer = null;
    }
    this.businessAddressLookupSub?.unsubscribe();
    this.businessAddressSearching.set(false);

    const query = String(raw || '').trim();
    if (query.length < 4) {
      this.businessAddressSuggestions.set([]);
      this.businessAddressNoMatches.set(false);
      return;
    }
    this.businessAddressSearchTimer = setTimeout(() => this.lookupBusinessAddressSuggestions(query), 320);
  }

  private lookupBusinessAddressSuggestions(query: string): void {
    this.businessAddressSearching.set(true);
    this.businessAddressNoMatches.set(false);
    this.businessAddressLookupSub = this.addressLookup.search(query, 6, 'us')
      .pipe(finalize(() => this.businessAddressSearching.set(false)))
      .subscribe({
        next: suggestions => {
          this.businessAddressSuggestions.set(suggestions);
          this.businessAddressNoMatches.set(query.length >= 4 && !suggestions.length);
        },
        error: () => {
          this.businessAddressSuggestions.set([]);
          this.businessAddressNoMatches.set(true);
        }
      });
  }
}
