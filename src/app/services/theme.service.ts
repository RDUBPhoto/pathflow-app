import { Injectable, effect, inject, signal } from '@angular/core';
import { AuthService } from '../auth/auth.service';
import { UserScopedSettingsService } from './user-scoped-settings.service';

export type ThemeMode = 'light' | 'dark';

const THEME_SETTING_KEY = 'ui.theme';
const LOCAL_THEME_KEY = 'pathflow.ui.theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly auth = inject(AuthService);
  private readonly userSettings = inject(UserScopedSettingsService);
  readonly mode = signal<ThemeMode>('dark');
  private themeLoadToken = 0;

  constructor() {
    const localMode = this.readLocalMode();
    this.mode.set(localMode);
    this.applyMode(localMode);

    effect(() => {
      const initialized = this.auth.initialized();
      const isAuthenticated = this.auth.isAuthenticated();
      if (!initialized) return;

      if (!isAuthenticated) {
        const next = this.readLocalMode();
        this.mode.set(next);
        this.applyMode(next);
        return;
      }

      this.userSettings.scope();
      const token = ++this.themeLoadToken;
      this.userSettings.getValue<ThemeMode>(THEME_SETTING_KEY).subscribe(value => {
        if (token !== this.themeLoadToken) return;
        const next: ThemeMode = value === 'light' ? 'light' : 'dark';
        this.mode.set(next);
        this.writeLocalMode(next);
        this.applyMode(next);
      });
    });
  }

  toggleMode(): void {
    this.setMode(this.mode() === 'dark' ? 'light' : 'dark');
  }

  setMode(mode: ThemeMode): void {
    this.mode.set(mode);
    this.writeLocalMode(mode);
    this.applyMode(mode);
    if (this.auth.isAuthenticated()) {
      this.userSettings.setValue(THEME_SETTING_KEY, mode).subscribe({ error: () => {} });
    }
  }

  private applyMode(mode: ThemeMode): void {
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.style.colorScheme = mode;
  }

  private readLocalMode(): ThemeMode {
    try {
      const raw = String(localStorage.getItem(LOCAL_THEME_KEY) || '').trim().toLowerCase();
      return raw === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  private writeLocalMode(mode: ThemeMode): void {
    try {
      localStorage.setItem(LOCAL_THEME_KEY, mode);
    } catch {
      // Ignore when storage is unavailable.
    }
  }
}
