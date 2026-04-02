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
  readonly googleEnabled = computed(() => this.auth.isProviderEnabled('google'));
  readonly primaryProviderLabel = computed(() => this.providerLabel(this.auth.primaryAuthProvider()));
  readonly hostedEmailEnabled = computed(
    () => !this.localServerMode && this.auth.isHostedEmailEnabled()
  );
  readonly devBypassEnabled = environment.auth.devBypass || this.isLocalHost;
  readonly localServerMode = this.isLocalHost && !this.isLikelySwaCli;
  readonly passwordLoginEnabled = computed(() => this.auth.isLocalPasswordAuthEnabled() || this.localServerMode);
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
  readonly passwordResetStatus = signal('');
  readonly passwordResetError = signal('');
  readonly passwordResetSending = signal(false);
  localLoginEmail = '';
  localLoginPassword = '';

  constructor() {
    addIcons({
      'shield-checkmark-outline': shieldCheckmarkOutline,
      'key-outline': keyOutline,
      'logo-google': logoGoogle
    });

    this.route.queryParamMap.subscribe(params => {
      this.redirectTo.set(this.normalizeRedirect(params.get('redirect')));
      const inviteEmail = String(params.get('email') || '').trim();
      if (inviteEmail && !this.localLoginEmail) {
        this.localLoginEmail = inviteEmail;
      }
    });

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

  signInPrimary(): void {
    this.passwordLoginError.set('');
    if (this.localServerMode) {
      this.localAuthHint.set('Microsoft/Google sign-in requires Azure Static Web Apps runtime. Use local quick access below or run with SWA CLI.');
      return;
    }
    this.auth.signIn(this.auth.primaryAuthProvider(), this.redirectTo());
  }

  signInGoogle(): void {
    this.passwordLoginError.set('');
    if (this.localServerMode) {
      this.localAuthHint.set('Google sign-in requires Azure Static Web Apps runtime. Use local quick access below or run with SWA CLI.');
      return;
    }
    this.auth.signIn('google', this.redirectTo());
  }

  signInHostedEmail(): void {
    this.passwordLoginError.set('');
    if (!this.hostedEmailEnabled()) return;
    const provider = this.auth.hostedEmailProvider();
    if (!provider) return;
    this.auth.signIn(provider, this.redirectTo());
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

  signInWithEmailPassword(): void {
    this.localAuthHint.set('');
    this.passwordLoginError.set('');
    this.passkeyLoginError.set('');
    this.passwordResetStatus.set('');
    this.passwordResetError.set('');

    const result = this.auth.signInWithEmailPassword(this.localLoginEmail, this.localLoginPassword);
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
