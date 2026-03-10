import { Component, DestroyRef, effect, inject } from '@angular/core';
import {
  IonApp, IonRouterOutlet
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { settingsOutline } from 'ionicons/icons';
import { ThemeService } from './services/theme.service';
import { AuthService } from './auth/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    IonApp, IonRouterOutlet
  ],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss']
})
export default class AppComponent {
  private static readonly IDLE_TIMEOUT_MS = 30 * 60 * 1000;
  private readonly auth = inject(AuthService);
  private readonly theme = inject(ThemeService);
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
    this.bindIdleTracking();

    effect(() => {
      if (!this.auth.isAuthenticated()) {
        this.clearIdleTimer();
        return;
      }
      this.bumpIdleTimer();
    });

    addIcons({
      'settings-outline': settingsOutline
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
}
