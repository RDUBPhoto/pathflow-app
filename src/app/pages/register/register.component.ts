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
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardSubtitle,
    IonCardContent,
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
  readonly locationName = signal('Exodus 4x4');
  readonly redirectTo = signal('/dashboard');

  readonly canSubmit = computed(() =>
    !this.saving() &&
    this.auth.canBootstrapRegistration() &&
    this.locationName().trim().length >= 3
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

    const response = await this.auth.registerWorkspace(this.locationName().trim());
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

  private normalizeRedirect(path: string | null): string {
    const value = (path || '').trim();
    if (!value.startsWith('/')) return '/dashboard';
    if (value.startsWith('/.auth/')) return '/dashboard';
    if (value.startsWith('/register')) return '/dashboard';
    return value;
  }
}
