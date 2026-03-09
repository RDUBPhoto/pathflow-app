import { Injectable, computed, inject, signal } from '@angular/core';
import { map, Observable, tap } from 'rxjs';
import { AppSettingsApiService } from './app-settings-api.service';

export type BusinessProfile = {
  companyName: string;
  companyEmail: string;
  companyPhone: string;
  companyAddress: string;
};

const BUSINESS_PROFILE_SETTING_KEY = 'business.profile';

function normalizeProfile(value: unknown): BusinessProfile {
  const source = value && typeof value === 'object' ? (value as Partial<BusinessProfile>) : {};
  return {
    companyName: String(source.companyName || '').trim(),
    companyEmail: String(source.companyEmail || '').trim(),
    companyPhone: String(source.companyPhone || '').trim(),
    companyAddress: String(source.companyAddress || '').trim()
  };
}

@Injectable({ providedIn: 'root' })
export class BusinessProfileService {
  private readonly settingsApi = inject(AppSettingsApiService);

  readonly profile = signal<BusinessProfile>({
    companyName: '',
    companyEmail: '',
    companyPhone: '',
    companyAddress: ''
  });
  readonly loaded = signal(false);
  readonly companyName = computed(() => this.profile().companyName);
  readonly companyEmail = computed(() => this.profile().companyEmail);
  readonly companyPhone = computed(() => this.profile().companyPhone);
  readonly companyAddress = computed(() => this.profile().companyAddress);

  constructor() {
    this.reload();
  }

  reload(): void {
    this.settingsApi.getValue<BusinessProfile>(BUSINESS_PROFILE_SETTING_KEY).subscribe({
      next: value => {
        this.profile.set(normalizeProfile(value));
        this.loaded.set(true);
      },
      error: () => {
        this.profile.set(normalizeProfile(null));
        this.loaded.set(true);
      }
    });
  }

  save(profile: BusinessProfile): Observable<BusinessProfile> {
    const normalized = normalizeProfile(profile);
    return this.settingsApi
      .setValue<BusinessProfile>(BUSINESS_PROFILE_SETTING_KEY, normalized)
      .pipe(
        map(res => normalizeProfile(res?.value)),
        tap(next => this.profile.set(next))
      );
  }
}
