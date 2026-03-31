import { Component, effect, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonAvatar,
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { keyOutline, personCircleOutline } from 'ionicons/icons';
import { AuthService } from '../../auth/auth.service';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';

@Component({
  selector: 'app-user-settings',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonContent,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonItem,
    IonLabel,
    IonInput,
    IonButton,
    IonIcon,
    IonBadge,
    IonAvatar,
    UserMenuComponent,
    PageBackButtonComponent,
    CompanySwitcherComponent
  ],
  templateUrl: './user-settings.component.html',
  styleUrls: ['./user-settings.component.scss']
})
export default class UserSettingsComponent {
  readonly auth = inject(AuthService);
  private profileInitialized = false;
  private profileBaseEmail = '';
  private profileBaseAvatarUrl = '';
  private readonly minPasswordLength = 8;

  email = '';
  avatarUrl = '';
  currentPassword = '';
  newPassword = '';
  confirmPassword = '';
  statusMessage = '';
  avatarUploadMessage = '';
  passkeyMessage = '';
  passkeyBusy = false;

  constructor() {
    addIcons({
      'person-circle-outline': personCircleOutline,
      'key-outline': keyOutline
    });

    effect(() => {
      const user = this.auth.user();
      if (!user) return;
      const nextEmail = (user.email || '').trim();
      const nextAvatar = (user.avatarUrl || '').trim();
      const wasDirty = this.profileInitialized ? this.hasProfileChanges() : false;

      this.profileBaseEmail = nextEmail;
      this.profileBaseAvatarUrl = nextAvatar;

      if (!this.profileInitialized || !wasDirty) {
        this.email = nextEmail;
        this.avatarUrl = nextAvatar;
        this.profileInitialized = true;
      }
    });
  }

  saveProfile(): void {
    if (!this.canSaveProfile()) {
      this.statusMessage = this.hasProfileChanges()
        ? 'Enter a valid email to save profile changes.'
        : 'No profile changes to save.';
      return;
    }

    const result = this.auth.updateProfile({
      email: this.email.trim(),
      avatarUrl: this.avatarUrl.trim()
    });

    if (!result.ok) {
      this.statusMessage = result.error || 'Unable to save profile.';
      return;
    }

    this.profileBaseEmail = this.email.trim().toLowerCase();
    this.profileBaseAvatarUrl = this.avatarUrl.trim();
    this.statusMessage = 'Profile changes saved.';
  }

  onAvatarFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.avatarUploadMessage = 'Please choose an image file.';
      input.value = '';
      return;
    }

    const maxBytes = 5 * 1024 * 1024;
    if (file.size > maxBytes) {
      this.avatarUploadMessage = 'Avatar file must be 5MB or smaller.';
      input.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!dataUrl) {
        this.avatarUploadMessage = 'Could not load that image.';
        return;
      }

      this.avatarUrl = dataUrl;
      this.avatarUploadMessage = 'Avatar loaded. Click Save Profile to apply.';
      input.value = '';
    };

    reader.onerror = () => {
      this.avatarUploadMessage = 'Avatar upload failed. Try a different image.';
      input.value = '';
    };

    reader.readAsDataURL(file);
  }

  clearAvatar(): void {
    this.avatarUrl = '';
    this.avatarUploadMessage = 'Avatar removed. Click Save Profile to apply.';
  }

  savePassword(): void {
    if (!this.canSavePassword()) {
      if (!this.hasPasswordChanges()) {
        this.statusMessage = 'No password changes to save.';
      } else if (!this.passwordFieldsComplete()) {
        this.statusMessage = 'Complete all password fields.';
      } else if (!this.newPasswordStrongEnough()) {
        this.statusMessage = `New password must be at least ${this.minPasswordLength} characters.`;
      } else if (!this.passwordsMatch()) {
        this.statusMessage = 'New password and confirmation do not match.';
      } else {
        this.statusMessage = 'Password update validation failed.';
      }
      return;
    }

    this.currentPassword = '';
    this.newPassword = '';
    this.confirmPassword = '';
    this.statusMessage = 'Password update queued (static scaffold).';
  }

  canManagePasskeys(): boolean {
    return this.auth.isLocalPasswordAuthEnabled();
  }

  passkeysSupported(): boolean {
    return this.auth.isPasskeySupported();
  }

  hasPasskey(): boolean {
    return this.auth.hasPasskeyForCurrentUser();
  }

  async enablePasskey(): Promise<void> {
    this.passkeyMessage = '';
    this.passkeyBusy = true;
    try {
      const res = await this.auth.registerPasskeyForCurrentUser();
      this.passkeyMessage = res.ok
        ? (res.message || 'Passkey enabled.')
        : (res.error || 'Could not enable passkey.');
    } finally {
      this.passkeyBusy = false;
    }
  }

  removePasskey(): void {
    this.passkeyMessage = '';
    const res = this.auth.removePasskeysForCurrentUser();
    this.passkeyMessage = res.ok
      ? (res.message || 'Passkey removed.')
      : (res.error || 'Could not remove passkey.');
  }

  isEmailValid(): boolean {
    const value = this.email.trim();
    return !!value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  hasProfileChanges(): boolean {
    if (!this.profileInitialized) return false;
    return this.email.trim().toLowerCase() !== this.profileBaseEmail.toLowerCase() ||
      this.avatarUrl.trim() !== this.profileBaseAvatarUrl;
  }

  canSaveProfile(): boolean {
    return this.hasProfileChanges() && this.isEmailValid();
  }

  hasPasswordChanges(): boolean {
    return !!this.currentPassword || !!this.newPassword || !!this.confirmPassword;
  }

  passwordFieldsComplete(): boolean {
    return !!this.currentPassword && !!this.newPassword && !!this.confirmPassword;
  }

  newPasswordStrongEnough(): boolean {
    return this.newPassword.length >= this.minPasswordLength;
  }

  passwordsMatch(): boolean {
    return this.newPassword === this.confirmPassword;
  }

  canSavePassword(): boolean {
    return this.hasPasswordChanges() && this.passwordFieldsComplete() && this.newPasswordStrongEnough() && this.passwordsMatch();
  }
}
