import { Injectable, effect, inject, signal } from '@angular/core';
import { UserScopedSettingsService } from './user-scoped-settings.service';

export type ThemeMode = 'light' | 'dark';

const THEME_SETTING_KEY = 'ui.theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly userSettings = inject(UserScopedSettingsService);
  readonly mode = signal<ThemeMode>('dark');
  private themeLoadToken = 0;

  constructor() {
    this.mode.set('dark');
    this.applyMode('dark');

    effect(() => {
      this.userSettings.scope();
      const token = ++this.themeLoadToken;
      this.userSettings.getValue<ThemeMode>(THEME_SETTING_KEY).subscribe(value => {
        if (token !== this.themeLoadToken) return;
        const next: ThemeMode = value === 'light' ? 'light' : 'dark';
        this.mode.set(next);
        this.applyMode(next);
      });
    });
  }

  toggleMode(): void {
    this.setMode(this.mode() === 'dark' ? 'light' : 'dark');
  }

  setMode(mode: ThemeMode): void {
    this.mode.set(mode);
    this.applyMode(mode);
    this.userSettings.setValue(THEME_SETTING_KEY, mode).subscribe({ error: () => {} });
  }

  private applyMode(mode: ThemeMode): void {
    document.documentElement.setAttribute('data-theme', mode);
    document.documentElement.style.colorScheme = mode;
  }
}
