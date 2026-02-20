import { Component, computed, effect, inject, signal } from '@angular/core';
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
import { AuthService } from '../../auth/auth.service';
import { TenantContextService } from '../../services/tenant-context.service';

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
export default class RegisterComponent {
  readonly auth = inject(AuthService);
  private readonly tenantContext = inject(TenantContextService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly saving = signal(false);
  readonly error = signal('');
  readonly locationName = signal('Pathflow HQ');
  readonly cardholderName = signal('');
  readonly cardNumber = signal('');
  readonly expiryMonth = signal('');
  readonly expiryYear = signal('');
  readonly cvc = signal('');
  readonly postalCode = signal('');
  readonly redirectTo = signal('/dashboard');

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
    this.auth.canBootstrapRegistration() &&
    this.locationName().trim().length >= 3 &&
    this.billingValid()
  );

  constructor() {
    this.route.queryParamMap.subscribe(params => {
      this.redirectTo.set(this.normalizeRedirect(params.get('redirect')));
    });

    effect(() => {
      if (!this.auth.initialized()) return;
      if (!this.auth.isAuthenticated()) return;
      if (this.auth.needsRegistration()) return;
      void this.router.navigateByUrl(this.redirectTo(), { replaceUrl: true });
    });
  }

  async registerWorkspace(): Promise<void> {
    if (!this.canSubmit()) return;

    this.saving.set(true);
    this.error.set('');

    const response = await this.auth.registerWorkspace(this.locationName().trim(), {
      cardholderName: this.cardholderName().trim(),
      cardNumber: this.digitsOnly(this.cardNumber()),
      expiryMonth: this.digitsOnly(this.expiryMonth()),
      expiryYear: this.digitsOnly(this.expiryYear()),
      cvc: this.digitsOnly(this.cvc()),
      postalCode: this.digitsOnly(this.postalCode()),
      sandboxBypass: this.isSandboxCard()
    });
    if (!response.ok) {
      this.error.set(response.error || 'Unable to complete registration.');
      this.saving.set(false);
      return;
    }

    const defaultLocation = this.auth.defaultLocationId();
    if (defaultLocation) {
      this.tenantContext.setTenantOverride(defaultLocation);
    }

    this.saving.set(false);
    await this.router.navigateByUrl(this.redirectTo(), { replaceUrl: true });
  }

  useDifferentAccount(): void {
    this.auth.signOut('/login');
  }

  private normalizeRedirect(path: string | null): string {
    const value = (path || '').trim();
    if (!value.startsWith('/')) return '/dashboard';
    if (value.startsWith('/.auth/')) return '/dashboard';
    if (value.startsWith('/register')) return '/dashboard';
    return value;
  }

  private digitsOnly(value: unknown): string {
    return String(value ?? '').replace(/\D+/g, '');
  }
}
