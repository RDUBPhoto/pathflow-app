import { Injectable, computed, inject } from '@angular/core';
import { AuthService } from '../auth/auth.service';

const TENANT_OVERRIDE_KEY = 'pathflow.tenant.id';

@Injectable({ providedIn: 'root' })
export class TenantContextService {
  private readonly auth = inject(AuthService);

  readonly tenantId = computed(() => {
    const override = this.readOverride();
    const emailTenant = this.tenantFromEmail(this.auth.user()?.email || '');
    const hostTenant = this.tenantFromHost(window.location.hostname || '');
    return this.sanitizeTenantId(override || emailTenant || hostTenant || 'main');
  });

  setTenantOverride(value: string): void {
    const next = this.sanitizeTenantId(value);
    try {
      localStorage.setItem(TENANT_OVERRIDE_KEY, next);
    } catch {
      // Ignore when storage is unavailable.
    }
  }

  clearTenantOverride(): void {
    try {
      localStorage.removeItem(TENANT_OVERRIDE_KEY);
    } catch {
      // Ignore when storage is unavailable.
    }
  }

  private readOverride(): string {
    try {
      return (localStorage.getItem(TENANT_OVERRIDE_KEY) || '').trim();
    } catch {
      return '';
    }
  }

  private tenantFromEmail(email: string): string {
    const value = String(email || '').trim().toLowerCase();
    const at = value.lastIndexOf('@');
    if (at < 0) return '';
    const domain = value.slice(at + 1);
    if (!domain || domain.includes('localhost')) return '';
    const root = domain.split('.')[0] || '';
    return this.sanitizeTenantId(root);
  }

  private tenantFromHost(hostname: string): string {
    const host = String(hostname || '').trim().toLowerCase();
    if (!host || host === 'localhost' || host === '127.0.0.1') return '';
    const parts = host.split('.').filter(Boolean);
    if (parts.length < 2) return '';
    if (parts.length >= 3 && parts[parts.length - 2] === 'pathflow' && parts[parts.length - 1] === 'com') {
      const first = parts[0];
      if (first && first !== 'app' && first !== 'www') return this.sanitizeTenantId(first);
    }
    return '';
  }

  private sanitizeTenantId(value: string): string {
    const cleaned = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    return cleaned || 'main';
  }
}
