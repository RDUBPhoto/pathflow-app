import { Component, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  IonAvatar,
  IonButton,
  IonContent,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonPopover
} from '@ionic/angular/standalone';
import { RouterLink } from '@angular/router';
import { addIcons } from 'ionicons';
import {
  chevronDownOutline,
  logOutOutline,
  personCircleOutline,
  shieldCheckmarkOutline
} from 'ionicons/icons';
import { AuthService } from '../../../auth/auth.service';

@Component({
  selector: 'app-user-menu',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    IonButton,
    IonAvatar,
    IonIcon,
    IonPopover,
    IonContent,
    IonList,
    IonItem,
    IonLabel
  ],
  templateUrl: './user-menu.component.html',
  styleUrls: ['./user-menu.component.scss']
})
export class UserMenuComponent {
  readonly auth = inject(AuthService);

  readonly menuOpen = signal(false);
  readonly menuEvent = signal<Event | null>(null);
  readonly avatarLoadError = signal(false);

  private readonly avatarPalette = [
    '#0f766e',
    '#1d4ed8',
    '#7c3aed',
    '#be185d',
    '#b45309',
    '#0f172a',
    '#334155',
    '#166534',
    '#9f1239'
  ];

  readonly user = computed(() => this.auth.user());
  readonly userDisplayName = computed(() => {
    const user = this.user();
    return (user?.displayName || user?.email || 'User').trim();
  });
  readonly userEmail = computed(() => (this.user()?.email || '').trim());
  readonly firstName = computed(() => this.extractFirstName(this.userDisplayName(), this.userEmail()));
  readonly initials = computed(() => this.extractInitials(this.userDisplayName(), this.userEmail()));
  readonly avatarUrl = computed(() => (this.user()?.avatarUrl || '').trim());
  readonly showAvatarImage = computed(() => !!this.avatarUrl() && !this.avatarLoadError());
  readonly avatarColor = computed(() => {
    const user = this.user();
    const seed = (user?.id || user?.email || user?.displayName || 'user').trim().toLowerCase();
    return this.pickColor(seed);
  });
  private lastAvatarUrl = '';

  constructor() {
    addIcons({
      'chevron-down-outline': chevronDownOutline,
      'person-circle-outline': personCircleOutline,
      'shield-checkmark-outline': shieldCheckmarkOutline,
      'log-out-outline': logOutOutline
    });

    effect(() => {
      const currentUrl = this.avatarUrl();
      if (currentUrl !== this.lastAvatarUrl) {
        this.lastAvatarUrl = currentUrl;
        this.avatarLoadError.set(false);
      }
    });
  }

  openMenu(event: Event): void {
    this.menuEvent.set(event);
    this.menuOpen.set(true);
  }

  closeMenu(): void {
    this.menuOpen.set(false);
  }

  onAvatarError(): void {
    this.avatarLoadError.set(true);
  }

  signOut(): void {
    this.closeMenu();
    this.auth.signOut('/login');
  }

  private extractFirstName(displayName: string, email: string): string {
    const cleanName = displayName.trim();
    if (cleanName) {
      const parts = cleanName.split(/\s+/).filter(Boolean);
      if (parts.length) return parts[0];
    }

    const emailLocal = (email.split('@')[0] || '').trim();
    const tokens = emailLocal.split(/[._-]+/).filter(Boolean);
    if (tokens.length) return this.capitalize(tokens[0]);

    return 'User';
  }

  private extractInitials(displayName: string, email: string): string {
    const cleanName = displayName.trim();
    if (cleanName) {
      const words = cleanName.split(/\s+/).filter(Boolean);
      if (words.length >= 2) {
        return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
      }

      const single = words[0] || '';
      if (single.length >= 2) return single.slice(0, 2).toUpperCase();
      if (single.length === 1) return `${single[0]}${single[0]}`.toUpperCase();
    }

    const local = (email.split('@')[0] || '').trim();
    const tokens = local.split(/[._-]+/).filter(Boolean);
    if (tokens.length >= 2) {
      return `${tokens[0][0]}${tokens[1][0]}`.toUpperCase();
    }

    if (local.length >= 2) return local.slice(0, 2).toUpperCase();
    if (local.length === 1) return `${local[0]}${local[0]}`.toUpperCase();
    return 'US';
  }

  private capitalize(value: string): string {
    if (!value) return value;
    return value[0].toUpperCase() + value.slice(1);
  }

  private pickColor(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    }

    const index = Math.abs(hash) % this.avatarPalette.length;
    return this.avatarPalette[index];
  }
}
