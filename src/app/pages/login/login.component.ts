import { Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonContent,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonSpinner
} from '@ionic/angular/standalone';
import { ActivatedRoute, Router } from '@angular/router';
import { addIcons } from 'ionicons';
import { keyOutline, lockClosedOutline, logoGoogle, shieldCheckmarkOutline } from 'ionicons/icons';
import { environment } from '../../../environments/environment';
import { AuthService } from '../../auth/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonContent,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardSubtitle,
    IonCardContent,
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
  readonly googleEnabled = computed(() => environment.auth.providers.includes('google'));
  readonly devBypassEnabled = environment.auth.devBypass || this.isLocalHost;
  readonly localServerMode = this.isLocalHost && !this.isLikelySwaCli;
  readonly passwordLoginEnabled = computed(() => environment.auth.localPasswordEnabled || this.localServerMode);
  readonly localCredentialHints = environment.auth.localUsers.map(user => ({
    email: user.email,
    password: user.password,
    role: user.role
  }));

  readonly localAuthHint = signal('');
  readonly passwordLoginError = signal('');
  localLoginEmail = '';
  localLoginPassword = '';

  constructor() {
    addIcons({
      'lock-closed-outline': lockClosedOutline,
      'shield-checkmark-outline': shieldCheckmarkOutline,
      'key-outline': keyOutline,
      'logo-google': logoGoogle
    });

    this.route.queryParamMap.subscribe(params => {
      this.redirectTo.set(this.normalizeRedirect(params.get('redirect')));
    });

    effect(() => {
      if (!this.auth.initialized()) return;
      if (!this.auth.isAuthenticated()) return;
      void this.router.navigateByUrl(this.redirectTo(), { replaceUrl: true });
    });
  }

  signInPrimary(): void {
    this.passwordLoginError.set('');
    if (this.localServerMode) {
      this.localAuthHint.set('Microsoft/Google sign-in requires Azure Static Web Apps runtime. Use local quick access below or run with SWA CLI.');
      return;
    }
    this.auth.signIn(environment.auth.primaryProvider, this.redirectTo());
  }

  signInGoogle(): void {
    this.passwordLoginError.set('');
    if (this.localServerMode) {
      this.localAuthHint.set('Google sign-in requires Azure Static Web Apps runtime. Use local quick access below or run with SWA CLI.');
      return;
    }
    this.auth.signIn('google', this.redirectTo());
  }

  signInDevAsUser(): void {
    this.auth.signInDev('user');
  }

  signInDevAsAdmin(): void {
    this.auth.signInDev('admin');
  }

  signInWithEmailPassword(): void {
    this.localAuthHint.set('');
    this.passwordLoginError.set('');

    const result = this.auth.signInWithEmailPassword(this.localLoginEmail, this.localLoginPassword);
    if (!result.ok) {
      this.passwordLoginError.set(result.error || 'Unable to sign in.');
      return;
    }
  }

  private normalizeRedirect(path: string | null): string {
    const value = (path || '').trim();
    if (!value.startsWith('/')) return '/dashboard';
    if (value.startsWith('/.auth/')) return '/dashboard';
    return value;
  }
}
