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
import { firstValueFrom } from 'rxjs';
import { addIcons } from 'ionicons';
import { keyOutline, logoGoogle, shieldCheckmarkOutline } from 'ionicons/icons';
import { AuthService } from '../../auth/auth.service';
import { BusinessProfileService } from '../../services/business-profile.service';
import { formatUsPhoneInput, phoneDigits } from '../../utils/phone-format';

type SignupMethod = 'email' | 'aad' | 'google';

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
  private readonly businessProfile = inject(BusinessProfileService);

  private readonly isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  private readonly isLikelySwaCli = this.isLocalHost && window.location.port === '4280';
  readonly localServerMode = this.isLocalHost && !this.isLikelySwaCli;

  readonly redirectTo = signal('/dashboard');
  readonly googleEnabled = computed(() => this.auth.isProviderEnabled('google'));
  readonly primaryProviderLabel = computed(() => this.providerLabel(this.auth.primaryAuthProvider()));
  readonly hostedEmailEnabled = computed(
    () => !this.localServerMode && this.auth.isHostedEmailEnabled()
  );
  readonly localEmailCredentialsEnabled = computed(
    () => this.auth.isLocalPasswordAuthEnabled()
  );
  readonly emailSignupEnabled = computed(
    () => this.localEmailCredentialsEnabled() || this.hostedEmailEnabled()
  );

  readonly step = signal<1 | 2>(1);
  readonly selectedMethod = signal<SignupMethod>('email');

  readonly fullName = signal('');
  readonly email = signal('');
  readonly phone = signal('');
  readonly password = signal('');
  readonly confirmPassword = signal('');
  readonly businessName = signal('');
  readonly businessEmail = signal('');
  readonly businessPhone = signal('');
  readonly businessAddress = signal('');
  readonly locationName = signal('Primary Location');

  readonly error = signal('');
  readonly hint = signal('');
  readonly saving = signal(false);

  readonly submitCta = computed(() => {
    if (this.selectedMethod() === 'email') {
      return this.localEmailCredentialsEnabled() ? 'Create workspace and start trial' : 'Continue with Email';
    }
    if (this.selectedMethod() === 'google') {
      return 'Continue with Google';
    }
    return `Continue with ${this.primaryProviderLabel()}`;
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

  readonly businessDetailsValid = computed(() => {
    const businessEmail = this.businessEmail().trim().toLowerCase();
    return (
      this.businessName().trim().length >= 2 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessEmail) &&
      this.digitsOnly(this.businessPhone()).length >= 10 &&
      this.businessAddress().trim().length >= 6 &&
      this.locationName().trim().length >= 3
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
      const inviteEmail = String(params.get('email') || '').trim();
      if (inviteEmail && !this.email()) {
        this.email.set(inviteEmail);
      }
      if (inviteEmail && !this.businessEmail()) {
        this.businessEmail.set(inviteEmail);
      }
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

  onPhoneInput(value: string | null | undefined): void {
    const formatted = formatUsPhoneInput(value);
    this.phone.set(formatted);
    if (!this.businessPhone().trim()) {
      this.businessPhone.set(formatted);
    }
  }

  onBusinessPhoneInput(value: string | null | undefined): void {
    this.businessPhone.set(formatUsPhoneInput(value));
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
    if (!this.businessName().trim()) {
      this.businessName.set(this.fullName().trim());
    }
    if (!this.businessEmail().trim()) {
      this.businessEmail.set(email);
    }
    if (!this.businessPhone().trim()) {
      this.businessPhone.set(this.phone());
    }
    if (this.locationName().trim() === 'Primary Location' && this.businessName().trim()) {
      this.locationName.set(this.businessName().trim());
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

  async submitSignup(): Promise<void> {
    this.error.set('');
    this.hint.set('');

    if (!this.businessDetailsValid()) {
      this.error.set('Enter business name, email, phone, address, and location name to start the trial.');
      return;
    }

    const registerRedirect = this.registerRedirect();
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

        this.saving.set(true);
        const result = await this.auth.createEmailPasswordAccount(
          this.email(),
          this.password(),
          this.fullName(),
          this.phone()
        );
        if (!result.ok) {
          this.error.set(result.error || 'Unable to create your account.');
          this.saving.set(false);
          return;
        }

        const workspace = await this.auth.registerWorkspace([this.locationName().trim()], undefined, 'monthly');
        if (!workspace.ok) {
          this.error.set(workspace.error || 'Unable to start your workspace trial.');
          this.saving.set(false);
          return;
        }

        try {
          await firstValueFrom(this.businessProfile.save({
            companyName: this.businessName().trim(),
            companyEmail: this.businessEmail().trim(),
            companyPhone: this.businessPhone().trim(),
            companyAddress: this.businessAddress().trim()
          }));
        } catch {
          // Non-blocking: the admin setup stepper can collect this again if needed.
        }

        this.saving.set(false);
        void this.router.navigateByUrl(this.redirectTo(), { replaceUrl: true });
        return;
      }

      if (this.hostedEmailEnabled()) {
        const runtimeProvider = this.auth.hostedEmailProvider();
        if (!runtimeProvider) {
          this.error.set('Hosted email sign-in provider is not configured.');
          return;
        }
        this.auth.signIn(runtimeProvider, registerRedirect);
        return;
      }

      this.error.set('Email sign-up is not enabled for hosted auth yet. Use Microsoft or Google.');
      return;
    }

    if (this.localServerMode) {
      this.hint.set(
        `${method === 'google' ? 'Google' : this.primaryProviderLabel()} sign-in requires Azure Static Web Apps runtime. Use Email & Password signup in local mode.`
      );
      return;
    }

    this.auth.signIn(this.resolveProviderForMethod(method), registerRedirect);
  }

  backToLogin(): void {
    void this.router.navigate(['/login'], {
      queryParams: { redirect: this.redirectTo() }
    });
  }

  private registerRedirect(): string {
    const params = new URLSearchParams();
    params.set('redirect', this.redirectTo());
    params.set('plan', 'trial');
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

  private resolveProviderForMethod(method: SignupMethod): string {
    if (method === 'google') return 'google';
    if (method === 'email') return this.auth.hostedEmailProvider() || this.auth.primaryAuthProvider();
    return this.auth.primaryAuthProvider();
  }

  private providerLabel(provider: string): string {
    const normalized = String(provider || '').trim().toLowerCase();
    if (normalized === 'aad') return 'Microsoft';
    if (normalized === 'google') return 'Google';
    if (normalized === 'github') return 'GitHub';
    if (normalized === 'twitter') return 'X';
    if (!normalized) return 'Provider';
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }
}
