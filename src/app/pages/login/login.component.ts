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
import { eyeOffOutline, eyeOutline, keyOutline } from 'ionicons/icons';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../auth/auth.service';

@Component({
  selector: 'app-login',
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
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export default class LoginComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);

  private readonly isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  private readonly isLikelySwaCli = this.isLocalHost && window.location.port === '4280';

  readonly redirectTo = signal('/dashboard');
  readonly devBypassEnabled = environment.auth.devBypass || this.isLocalHost;
  readonly localServerMode = this.isLocalHost && !this.isLikelySwaCli;
  readonly passwordLoginEnabled = computed(() => this.auth.isLocalPasswordAuthEnabled() || this.localServerMode);
  readonly federatedProviders = computed(() => {
    const out: Array<{ key: string; label: string }> = [];
    if (this.auth.isProviderEnabled('aad')) out.push({ key: 'aad', label: 'Continue with Microsoft' });
    if (this.auth.isProviderEnabled('google')) out.push({ key: 'google', label: 'Continue with Google' });
    if (this.auth.isHostedEmailEnabled()) {
      const hosted = String(this.auth.hostedEmailProvider() || '').trim().toLowerCase();
      if (hosted) out.push({ key: hosted, label: 'Continue with Email' });
    }
    return out;
  });
  readonly localCredentialHints = environment.auth.localUsers.map(user => ({
    email: user.email,
    password: user.password,
    role: user.role,
    isSuperAdmin: !!user.isSuperAdmin
  }));

  readonly localAuthHint = signal('');
  readonly passwordLoginError = signal('');
  readonly passkeyLoginError = signal('');
  readonly passkeyLoginBusy = signal(false);
  readonly postLoginSetupBusy = signal(false);
  readonly passwordResetStatus = signal('');
  readonly passwordResetError = signal('');
  readonly passwordResetSending = signal(false);
  localLoginEmail = '';
  localLoginPassword = '';
  showPassword = false;
  enableBiometricsNextLogin = false;
  readonly biometricsPromptVisible = signal(false);
  private readonly passkeyPrefStorageKey = 'pathflow.auth.passkey.pref';
  private readonly passkeyLastEmailStorageKey = 'pathflow.auth.passkey.last-email';
  private attemptedAutoPasskey = false;

  constructor() {
    addIcons({
      'key-outline': keyOutline,
      'eye-outline': eyeOutline,
      'eye-off-outline': eyeOffOutline
    });

    this.route.queryParamMap.subscribe(params => {
      this.redirectTo.set(this.normalizeRedirect(params.get('redirect')));
      const inviteEmail = String(params.get('email') || '').trim();
      if (inviteEmail && !this.localLoginEmail) {
        this.localLoginEmail = inviteEmail;
        this.maybeAutoTriggerPasskey();
      } else {
        this.primeRememberedBiometricEmail();
      }
    });

    effect(() => {
      if (!this.auth.initialized()) return;
      if (!this.auth.isAuthenticated()) return;
      if (this.postLoginSetupBusy()) return;
      if (this.auth.needsRegistration() || this.auth.isAccessLocked()) {
        void this.router.navigate(['/register'], {
          replaceUrl: true,
          queryParams: { redirect: this.redirectTo() }
        });
        return;
      }
      void this.router.navigateByUrl(this.redirectTo(), { replaceUrl: true });
    });

    effect(() => {
      if (!this.auth.initialized()) return;
      if (this.auth.isAuthenticated()) return;
      this.maybeAutoTriggerPasskey();
    });
  }

  onEmailInputChanged(): void {
    this.attemptedAutoPasskey = false;
    this.passwordLoginError.set('');
    this.passkeyLoginError.set('');
    this.passwordResetStatus.set('');
    this.passwordResetError.set('');
    this.maybeAutoTriggerPasskey();
  }

  startRegistration(): void {
    this.passwordLoginError.set('');

    if (this.auth.isAuthenticated() && (this.auth.needsRegistration() || this.auth.isAccessLocked())) {
      void this.router.navigate(['/register'], {
        replaceUrl: true,
        queryParams: { redirect: '/dashboard' }
      });
      return;
    }

    void this.router.navigate(['/signup'], {
      queryParams: { redirect: this.redirectTo() }
    });
  }

  signInDevAsUser(): void {
    this.auth.signInDev('user');
  }

  signInDevAsAdmin(): void {
    this.auth.signInDev('admin');
  }

  signInDevAsSuperAdmin(): void {
    this.auth.signInDevSuperAdmin();
  }

  signInWithProvider(provider: string): void {
    this.auth.signIn(provider, this.redirectTo());
  }

  async signInWithEmailPassword(): Promise<void> {
    this.localAuthHint.set('');
    this.passwordLoginError.set('');
    this.passkeyLoginError.set('');
    this.passwordResetStatus.set('');
    this.passwordResetError.set('');

    this.postLoginSetupBusy.set(true);
    try {
      const result = await this.auth.signInWithEmailPassword(this.localLoginEmail, this.localLoginPassword);
      if (!result.ok) {
        const errorText = (result.error || '').toLowerCase();
        if (
          errorText.includes('not enabled') ||
          errorText.includes('invalid') ||
          errorText.includes('incorrect') ||
          errorText.includes('unauthorized')
        ) {
          this.passwordLoginError.set('Email/Password is not correct. Do you need to create an account?');
          return;
        }

        this.passwordLoginError.set(result.error || 'Email/Password is not correct. Do you need to create an account?');
        return;
      }

      if (this.enableBiometricsNextLogin && this.auth.isPasskeySupported()) {
        const enroll = await this.auth.registerPasskeyForCurrentUser();
        if (!enroll.ok) {
          this.passkeyLoginError.set(enroll.error || 'Could not enable biometrics on this device.');
          return;
        }
        this.setBiometricPreference(this.localLoginEmail, true);
        this.setLastBiometricEmail(this.localLoginEmail);
      }
      this.setLastBiometricEmail(this.localLoginEmail);
    } finally {
      this.postLoginSetupBusy.set(false);
    }
  }

  async signInWithPasskey(): Promise<void> {
    this.localAuthHint.set('');
    this.passwordLoginError.set('');
    this.passkeyLoginError.set('');
    this.passwordResetStatus.set('');
    this.passwordResetError.set('');

    this.passkeyLoginBusy.set(true);
    try {
      const result = await this.auth.signInWithPasskey(this.localLoginEmail);
      if (!result.ok) {
        this.passkeyLoginError.set(result.error || 'Could not sign in with biometrics.');
        this.biometricsPromptVisible.set(true);
      } else {
        this.setLastBiometricEmail(this.localLoginEmail);
        this.biometricsPromptVisible.set(false);
      }
    } finally {
      this.passkeyLoginBusy.set(false);
    }
  }

  async requestPasswordReset(): Promise<void> {
    this.localAuthHint.set('');
    this.passwordLoginError.set('');
    this.passwordResetStatus.set('');
    this.passwordResetError.set('');
    const email = this.localLoginEmail.trim().toLowerCase();
    if (!email) {
      this.passwordResetError.set('Enter your email first, then click Forgot password.');
      return;
    }
    this.passwordResetSending.set(true);
    try {
      const result = await this.auth.requestPasswordReset(email);
      if (!result.ok) {
        this.passwordResetError.set(result.error || 'Could not send reset email.');
        return;
      }
      this.passwordResetStatus.set(result.message || 'If that account exists, a reset email has been sent.');
    } finally {
      this.passwordResetSending.set(false);
    }
  }

  private normalizeRedirect(path: string | null): string {
    const value = (path || '').trim();
    if (!value.startsWith('/')) return '/dashboard';
    if (value.startsWith('/.auth/')) return '/dashboard';
    return value;
  }

  private maybeAutoTriggerPasskey(): void {
    if (!this.passwordLoginEnabled()) return;
    if (!this.auth.isPasskeySupported()) return;
    if (this.passkeyLoginBusy() || this.auth.loading()) return;
    const email = String(this.localLoginEmail || '').trim().toLowerCase();
    if (!email) {
      this.biometricsPromptVisible.set(false);
      return;
    }
    const hasPasskey = this.auth.hasPasskeyForEmail(email);
    const rememberedEmail = this.getLastBiometricEmail();
    const hasPromptPreference = this.getBiometricPreference(email) || rememberedEmail === email;
    const shouldPrompt = hasPasskey && hasPromptPreference;
    this.biometricsPromptVisible.set(shouldPrompt);
    if (!shouldPrompt || this.attemptedAutoPasskey) return;
    // Show biometric prompt, but do not auto-submit. Auto-submit can loop
    // when sessions expire and the login page rehydrates repeatedly.
    this.attemptedAutoPasskey = true;
  }

  usePasswordInstead(): void {
    this.biometricsPromptVisible.set(false);
  }

  changeBiometricEmail(): void {
    this.biometricsPromptVisible.set(false);
    this.passkeyLoginError.set('');
    this.localLoginPassword = '';
    this.localLoginEmail = '';
    this.attemptedAutoPasskey = false;
    try {
      localStorage.removeItem(this.passkeyLastEmailStorageKey);
    } catch {
      // no-op
    }
  }

  onPasswordBlur(): void {
    this.showPassword = false;
  }

  private getBiometricPreference(emailInput: string): boolean {
    const email = String(emailInput || '').trim().toLowerCase();
    if (!email) return false;
    try {
      const raw = localStorage.getItem(this.passkeyPrefStorageKey);
      const parsed = raw ? JSON.parse(raw) as Record<string, boolean> : {};
      return !!parsed[email];
    } catch {
      return false;
    }
  }

  private setBiometricPreference(emailInput: string, enabled: boolean): void {
    const email = String(emailInput || '').trim().toLowerCase();
    if (!email) return;
    try {
      const raw = localStorage.getItem(this.passkeyPrefStorageKey);
      const parsed = raw ? JSON.parse(raw) as Record<string, boolean> : {};
      parsed[email] = enabled;
      localStorage.setItem(this.passkeyPrefStorageKey, JSON.stringify(parsed));
    } catch {
      // no-op
    }
  }

  private getLastBiometricEmail(): string {
    return String(localStorage.getItem(this.passkeyLastEmailStorageKey) || '').trim().toLowerCase();
  }

  private setLastBiometricEmail(emailInput: string): void {
    const email = String(emailInput || '').trim().toLowerCase();
    if (!email) return;
    try {
      localStorage.setItem(this.passkeyLastEmailStorageKey, email);
    } catch {
      // no-op
    }
  }

  private primeRememberedBiometricEmail(): void {
    if (String(this.localLoginEmail || '').trim()) return;
    const remembered = this.getLastBiometricEmail();
    if (!remembered) return;
    this.localLoginEmail = remembered;
    this.maybeAutoTriggerPasskey();
  }
}
