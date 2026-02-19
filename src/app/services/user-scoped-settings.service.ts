import { Injectable, computed, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { AppSettingsApiService } from './app-settings-api.service';

@Injectable({ providedIn: 'root' })
export class UserScopedSettingsService {
  private readonly auth = inject(AuthService);
  private readonly settingsApi = inject(AppSettingsApiService);

  readonly scope = computed(() => {
    const user = this.auth.user();
    const base = String(user?.id || user?.email || 'anonymous')
      .trim()
      .toLowerCase();
    return this.sanitize(base);
  });

  getValue<T>(baseKey: string): Observable<T | null> {
    return this.settingsApi.getValue<T>(this.buildKey(baseKey));
  }

  setValue<T>(baseKey: string, value: T) {
    return this.settingsApi.setValue<T>(this.buildKey(baseKey), value);
  }

  deleteValue(baseKey: string) {
    return this.settingsApi.deleteValue(this.buildKey(baseKey));
  }

  private buildKey(baseKey: string): string {
    const key = this.sanitize(baseKey).replace(/\.+/g, '.');
    return `user.${this.scope()}.${key}`;
  }

  private sanitize(value: string): string {
    const cleaned = String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 120);
    return cleaned || 'anonymous';
  }
}
