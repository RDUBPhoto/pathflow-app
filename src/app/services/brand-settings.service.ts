import { Injectable, effect, inject, signal } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { AppSettingsApiService } from './app-settings-api.service';

const BRAND_LOGO_SETTING_KEY = 'branding.logoUrl';
const DEFAULT_BRAND_LOGO_URL = '';

function normalizeLogoUrl(rawUrl: string): string {
  const value = (rawUrl || '').trim();
  if (!value) return '';
  if (value.startsWith('/api/brandingUpload?')) return value;
  const marker = '/branding/';
  const markerIndex = value.indexOf(marker);
  if (markerIndex >= 0) {
    const blobName = value.slice(markerIndex + marker.length).replace(/^\/+/, '');
    if (blobName) return `/api/brandingUpload?blob=${encodeURIComponent(blobName)}`;
  }
  return value;
}

@Injectable({ providedIn: 'root' })
export class BrandSettingsService {
  private readonly auth = inject(AuthService);
  private readonly settingsApi = inject(AppSettingsApiService);
  readonly defaultLogoUrl = DEFAULT_BRAND_LOGO_URL;
  readonly logoUrl = signal<string>('');
  readonly loaded = signal(false);
  readonly hasCustomLogo = signal(false);
  private loadToken = 0;

  constructor() {
    effect(() => {
      const initialized = this.auth.initialized();
      const isAuthenticated = this.auth.isAuthenticated();
      if (!initialized) return;

      if (!isAuthenticated) {
        this.loadToken += 1;
        this.hasCustomLogo.set(false);
        this.logoUrl.set('');
        this.loaded.set(true);
        return;
      }

      const token = ++this.loadToken;
      this.loaded.set(false);
      this.settingsApi.getValue<string>(BRAND_LOGO_SETTING_KEY).subscribe(value => {
        if (token !== this.loadToken) return;
        const next = normalizeLogoUrl((value || '').trim());
        this.hasCustomLogo.set(!!next);
        this.logoUrl.set(next || this.defaultLogoUrl);
        this.loaded.set(true);
      }, () => {
        if (token !== this.loadToken) return;
        this.hasCustomLogo.set(false);
        this.logoUrl.set('');
        this.loaded.set(true);
      });
    });
  }

  setLogoUrl(url: string): void {
    const next = normalizeLogoUrl((url || '').trim());
    if (!next) {
      this.resetLogo();
      return;
    }

    this.hasCustomLogo.set(true);
    this.logoUrl.set(next);
    this.settingsApi.setValue(BRAND_LOGO_SETTING_KEY, next).subscribe({ error: () => {} });
  }

  resetLogo(): void {
    this.hasCustomLogo.set(false);
    this.logoUrl.set('');
    this.settingsApi.deleteValue(BRAND_LOGO_SETTING_KEY).subscribe({ error: () => {} });
  }
}
