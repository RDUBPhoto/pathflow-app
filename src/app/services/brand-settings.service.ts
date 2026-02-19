import { Injectable, inject, signal } from '@angular/core';
import { AppSettingsApiService } from './app-settings-api.service';

const BRAND_LOGO_SETTING_KEY = 'branding.logoUrl';
const DEFAULT_BRAND_LOGO_URL = '/exodus-logo.png';

@Injectable({ providedIn: 'root' })
export class BrandSettingsService {
  private readonly settingsApi = inject(AppSettingsApiService);
  readonly defaultLogoUrl = DEFAULT_BRAND_LOGO_URL;
  readonly logoUrl = signal<string>(DEFAULT_BRAND_LOGO_URL);

  constructor() {
    this.settingsApi.getValue<string>(BRAND_LOGO_SETTING_KEY).subscribe(value => {
      const next = (value || '').trim();
      this.logoUrl.set(next || this.defaultLogoUrl);
    });
  }

  setLogoUrl(url: string): void {
    const next = (url || '').trim();
    if (!next) {
      this.resetLogo();
      return;
    }

    this.logoUrl.set(next);
    this.settingsApi.setValue(BRAND_LOGO_SETTING_KEY, next).subscribe({ error: () => {} });
  }

  resetLogo(): void {
    this.logoUrl.set(this.defaultLogoUrl);
    this.settingsApi.deleteValue(BRAND_LOGO_SETTING_KEY).subscribe({ error: () => {} });
  }
}
