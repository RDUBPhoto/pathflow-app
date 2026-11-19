import { RouterOutlet } from '@angular/router';
import { Component, DestroyRef, effect, inject, ChangeDetectionStrategy } from '@angular/core';
import { ThemeService } from './services/theme.service';
import { AuthService } from './auth/auth.service';
import { BrandSettingsService } from './services/brand-settings.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
     RouterOutlet
  ],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./app.component.scss']
})
export default class AppComponent {
  private static readonly IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  private static readonly DEFAULT_FAVICON_URL = 'favicon.ico';
  private static readonly FAVICON_LINK_ID = 'pathflow-dynamic-favicon';
  private readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);
  private readonly branding = inject(BrandSettingsService);
  private readonly destroyRef = inject(DestroyRef);
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly activityListener = () => this.bumpIdleTimer();
  private readonly trackedEvents: Array<keyof WindowEventMap> = [
    'mousemove',
    'mousedown',
    'keydown',
    'scroll',
    'touchstart',
    'click',
    'focus'
  ];

  constructor() {
    // Keep app theme initialized at bootstrap.
    void this.theme;
    this.runCustomerDataResetIfRequested();
    this.bindIdleTracking();

    effect(() => {
      if (!this.auth.isAuthenticated()) {
        this.clearIdleTimer();
        return;
      }
      this.bumpIdleTimer();
    });

    effect(() => {
      const isAuthenticated = this.auth.isAuthenticated();
      const brandingLoaded = this.branding.loaded();
      const logoUrl = this.branding.logoUrl();
      const hasCustomLogo = this.branding.hasCustomLogo();

      if (!isAuthenticated) {
        this.applyFavicon(AppComponent.DEFAULT_FAVICON_URL);
        return;
      }

      if (!brandingLoaded) return;
      this.applyFavicon(hasCustomLogo ? logoUrl : AppComponent.DEFAULT_FAVICON_URL);
    });

  }

  private bindIdleTracking(): void {
    for (const eventName of this.trackedEvents) {
      window.addEventListener(eventName, this.activityListener, { passive: true });
    }

    this.destroyRef.onDestroy(() => {
      for (const eventName of this.trackedEvents) {
        window.removeEventListener(eventName, this.activityListener);
      }
      this.clearIdleTimer();
    });
  }

  private bumpIdleTimer(): void {
    if (!this.auth.isAuthenticated()) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.auth.isAuthenticated()) return;
      this.auth.signOut('/login?reason=idle');
    }, AppComponent.IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer == null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private applyFavicon(rawUrl: string): void {
    if (typeof document === 'undefined') return;
    const head = document.head || document.getElementsByTagName('head')[0];
    if (!head) return;

    const nextHref = this.normalizeFaviconUrl(rawUrl);
    const selector = `link#${AppComponent.FAVICON_LINK_ID}[rel='icon']`;
    let link = head.querySelector(selector) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.id = AppComponent.FAVICON_LINK_ID;
      link.rel = 'icon';
      head.appendChild(link);
    }
    if (link.href !== nextHref) link.href = nextHref;
  }

  private normalizeFaviconUrl(rawUrl: string): string {
    const fallback = AppComponent.DEFAULT_FAVICON_URL;
    const input = String(rawUrl || '').trim() || fallback;
    if (input.startsWith('data:')) return input;

    try {
      const resolved = new URL(input, window.location.origin);
      // Force browser refresh when logo path is API-backed and cached aggressively.
      if (resolved.pathname === '/api/brandingUpload') {
        resolved.searchParams.set('favicon', '1');
      }
      return resolved.toString();
    } catch {
      return fallback;
    }
  }

  private runCustomerDataResetIfRequested(): void {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search || '');
    const shouldReset =
      params.get('resetCustomerData') === '1'
      || params.get('resetCustomerData') === 'true';
    if (!shouldReset) return;

    const keep = [
      /^pathflow\.auth\./i,
      /^pathflow\.dev\.auth\.user$/i,
      /^pathflow\.local\.password\.accounts$/i,
      /^pathflow\.local\.passkeys$/i,
      /^pathflow\.tenant\.id$/i,
      /^pathflow\.ui\.theme$/i
    ];
    const shouldKeep = (key: string): boolean => keep.some(pattern => pattern.test(key));
    const shouldClear = (key: string): boolean => {
      if (!/^pathflow\./i.test(key)) return false;
      if (shouldKeep(key)) return false;
      return /invoice|quote|customer|workitem|notification|sms|message|job|schedule|purchase|task|attachment/i.test(key);
    };

    try {
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index) || '';
        if (shouldClear(key)) localStorage.removeItem(key);
      }
    } catch {
      // Ignore storage errors; this is a local/dev reset helper only.
    }

    try {
      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = sessionStorage.key(index) || '';
        if (shouldClear(key)) sessionStorage.removeItem(key);
      }
    } catch {
      // Ignore storage errors; this is a local/dev reset helper only.
    }

    params.delete('resetCustomerData');
    const nextQuery = params.toString();
    const nextUrl = `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ''}${window.location.hash || ''}`;
    window.history.replaceState(null, '', nextUrl);
    window.location.reload();
  }
}
