import { Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonButton,
  IonContent,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonSpinner
} from '@ionic/angular/standalone';
import { ActivatedRoute, Router } from '@angular/router';
import { addIcons } from 'ionicons';
import { keyOutline, logoGoogle, shieldCheckmarkOutline } from 'ionicons/icons';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../auth/auth.service';
import { formatUsPhoneInput, phoneDigits } from '../../utils/phone-format';

type SignupMethod = 'email' | 'aad' | 'google';
type SignupPlan = 'trial' | 'monthly' | 'annual';

@Component({
  selector: 'app-signup',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonContent,
    IonButton,
    IonIcon,
    IonItem,
    IonLabel,
    IonInput,
    IonSpinner
  ],
  templateUrl: './signup.component.html',
  styleUrls: ['./signup.component.scss']
})
export default class SignupComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);

  private readonly isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  private readonly isLikelySwaCli = this.isLocalHost && window.location.port === '4280';
  readonly localServerMode = this.isLocalHost && !this.isLikelySwaCli;

  readonly redirectTo = signal('/dashboard');
  readonly googleEnabled = computed(() => environment.auth.providers.includes('google'));
  readonly hostedEmailEnabled = computed(
    () => !this.localServerMode && !!environment.auth.hostedEmailEnabled && !!String(environment.auth.hostedEmailProvider || '').trim()
  );
  readonly localEmailCredentialsEnabled = computed(
    () => environment.auth.localPasswordEnabled || environment.auth.devBypass || this.isLocalHost
  );
  readonly emailSignupEnabled = computed(
    () => this.localEmailCredentialsEnabled() || this.hostedEmailEnabled()
  );

  readonly step = signal<1 | 2>(1);
  readonly selectedMethod = signal<SignupMethod>('email');
  readonly selectedPlan = signal<SignupPlan>('trial');
  readonly monthlyPrice = signal(149);
  readonly annualPrice = signal(1490);

  readonly fullName = signal('');
  readonly email = signal('');
  readonly phone = signal('');
  readonly password = signal('');
  readonly confirmPassword = signal('');

  readonly error = signal('');
  readonly hint = signal('');

  readonly annualSavingsPercent = computed(() => {
    const monthly = this.monthlyPrice();
    const annual = this.annualPrice();
    if (monthly <= 0 || annual <= 0) return 0;
    const yearlyMonthly = monthly * 12;
    const savings = Math.max(0, yearlyMonthly - annual);
    return Math.round((savings / yearlyMonthly) * 100);
  });

  readonly submitCta = computed(() => {
    if (this.selectedMethod() === 'email') {
      return this.localEmailCredentialsEnabled() ? 'Create account and continue' : 'Continue with Email';
    }
    if (this.selectedMethod() === 'google') {
      return 'Continue with Google';
    }
    return 'Continue with Microsoft';
  });

  readonly stepOneValid = computed(() => {
    if (this.selectedMethod() !== 'email') return true;
    if (!this.emailSignupEnabled()) return false;
    const localEmailMode = this.localEmailCredentialsEnabled();
    if (!localEmailMode) return true;

    const email = this.email().trim().toLowerCase();
    const password = this.password();

    return (
      this.fullName().trim().length >= 2 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
      this.digitsOnly(this.phone()).length >= 10 &&
      password.length >= 8 &&
      password === this.confirmPassword()
    );
  });

  constructor() {
    addIcons({
      'shield-checkmark-outline': shieldCheckmarkOutline,
      'key-outline': keyOutline,
      'logo-google': logoGoogle
    });

    this.route.queryParamMap.subscribe(params => {
      this.redirectTo.set(this.normalizeRedirect(params.get('redirect')));
    });

    if (!this.emailSignupEnabled()) {
      this.selectedMethod.set(this.googleEnabled() ? 'google' : 'aad');
    }

    effect(() => {
      if (!this.auth.initialized()) return;
      if (!this.auth.isAuthenticated()) return;
      if (this.auth.needsRegistration() || this.auth.isAccessLocked()) {
        void this.router.navigate(['/register'], {
          replaceUrl: true,
          queryParams: { redirect: this.redirectTo() }
        });
        return;
      }
      void this.router.navigateByUrl(this.redirectTo(), { replaceUrl: true });
    });
  }

  setMethod(method: SignupMethod): void {
    this.error.set('');
    this.hint.set('');
    if (method === 'email' && !this.emailSignupEnabled()) {
      this.error.set('Email/password sign-up is not available yet. Use Microsoft or Google.');
      return;
    }
    if (method === 'google' && !this.googleEnabled()) {
      this.selectedMethod.set('aad');
      return;
    }
    this.selectedMethod.set(method);
  }

  setPlan(plan: SignupPlan): void {
    this.selectedPlan.set(plan);
  }

  onPhoneInput(value: string | null | undefined): void {
    this.phone.set(formatUsPhoneInput(value));
  }

  goToPlans(): void {
    this.error.set('');
    this.hint.set('');

    if (this.selectedMethod() !== 'email') {
      this.step.set(2);
      return;
    }

    if (!this.emailSignupEnabled()) {
      this.error.set('Email/password sign-up is not enabled for hosted auth yet. Use Microsoft or Google.');
      return;
    }

    const localEmailMode = this.localEmailCredentialsEnabled();
    if (!localEmailMode) {
      this.step.set(2);
      return;
    }

    const email = this.email().trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.error.set('Enter a valid email address.');
      return;
    }
    if (this.fullName().trim().length < 2) {
      this.error.set('Enter your full name.');
      return;
    }
    if (this.digitsOnly(this.phone()).length < 10) {
      this.error.set('Enter a valid phone number.');
      return;
    }
    if (this.password().length < 8) {
      this.error.set('Password must be at least 8 characters.');
      return;
    }
    if (this.password() !== this.confirmPassword()) {
      this.error.set('Passwords do not match.');
      return;
    }

    this.step.set(2);
  }

  backToAccount(): void {
    this.error.set('');
    this.hint.set('');
    this.step.set(1);
  }

  submitSignup(): void {
    this.error.set('');
    this.hint.set('');

    const plan = this.selectedPlan();
    const registerRedirect = this.registerRedirect(plan);
    const method = this.selectedMethod();

    if (method === 'email') {
      const localEmailMode = this.localEmailCredentialsEnabled();
      if (localEmailMode) {
        if (!this.emailSignupEnabled()) {
          this.error.set('Email sign-up is not enabled for this environment. Use Microsoft or Google.');
          return;
        }

        if (this.password() !== this.confirmPassword()) {
          this.error.set('Passwords do not match.');
          return;
        }

        const result = this.auth.createEmailPasswordAccount(
          this.email(),
          this.password(),
          this.fullName(),
          this.phone()
        );
        if (!result.ok) {
          this.error.set(result.error || 'Unable to create your account.');
          return;
        }

        void this.router.navigate(['/register'], {
          replaceUrl: true,
          queryParams: { redirect: this.redirectTo(), plan }
        });
        return;
      }

      if (this.hostedEmailEnabled()) {
        const provider = String(environment.auth.hostedEmailProvider || '').trim();
        if (!provider) {
          this.error.set('Hosted email sign-in provider is not configured.');
          return;
        }
        this.auth.signIn(provider, registerRedirect);
        return;
      }

      this.error.set('Email sign-up is not enabled for hosted auth yet. Use Microsoft or Google.');
      return;
    }

    if (this.localServerMode) {
      this.hint.set(
        `${method === 'google' ? 'Google' : 'Microsoft'} sign-in requires Azure Static Web Apps runtime. Use Email & Password signup in local mode.`
      );
      return;
    }

    this.auth.signIn(method, registerRedirect);
  }

  backToLogin(): void {
    void this.router.navigate(['/login'], {
      queryParams: { redirect: this.redirectTo() }
    });
  }

  private registerRedirect(plan: SignupPlan): string {
    const params = new URLSearchParams();
    params.set('redirect', this.redirectTo());
    params.set('plan', plan);
    return `/register?${params.toString()}`;
  }

  private normalizeRedirect(path: string | null): string {
    const value = (path || '').trim();
    if (!value.startsWith('/')) return '/dashboard';
    if (value.startsWith('/.auth/')) return '/dashboard';
    if (value.startsWith('/register') || value.startsWith('/signup')) return '/dashboard';
    return value;
  }

  private digitsOnly(value: unknown): string {
    return phoneDigits(value);
  }
}
