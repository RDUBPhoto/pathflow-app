import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  IonButton,
  IonContent,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonPopover
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  businessOutline,
  checkmarkCircleOutline,
  chevronDownOutline
} from 'ionicons/icons';
import { AuthService } from '../../../auth/auth.service';
import { TenantContextService } from '../../../services/tenant-context.service';

@Component({
  selector: 'app-company-switcher',
  standalone: true,
  imports: [
    CommonModule,
    IonButton,
    IonIcon,
    IonPopover,
    IonContent,
    IonList,
    IonItem,
    IonLabel
  ],
  templateUrl: './company-switcher.component.html',
  styleUrls: ['./company-switcher.component.scss']
})
export class CompanySwitcherComponent {
  readonly auth = inject(AuthService);
  private readonly tenantContext = inject(TenantContextService);

  readonly open = signal(false);
  readonly menuEvent = signal<Event | null>(null);
  readonly locations = computed(() => this.auth.locations());
  readonly activeLocationId = computed(() => this.tenantContext.tenantId());
  readonly show = computed(() => this.locations().length > 1);
  readonly activeLocationName = computed(() => {
    const activeId = this.activeLocationId();
    const locations = this.locations();
    return locations.find(location => location.id === activeId)?.name || locations[0]?.name || 'Location';
  });

  constructor() {
    addIcons({
      'business-outline': businessOutline,
      'chevron-down-outline': chevronDownOutline,
      'checkmark-circle-outline': checkmarkCircleOutline
    });
  }

  openMenu(event: Event): void {
    if (!this.show()) return;
    this.menuEvent.set(event);
    this.open.set(true);
  }

  closeMenu(): void {
    this.open.set(false);
  }

  isActiveLocation(locationId: string): boolean {
    const value = String(locationId || '').trim().toLowerCase();
    return value !== '' && value === this.activeLocationId();
  }

  switchLocation(locationId: string): void {
    const next = String(locationId || '').trim().toLowerCase();
    if (!next || next === this.activeLocationId()) {
      this.closeMenu();
      return;
    }

    this.tenantContext.setTenantOverride(next);
    this.closeMenu();
    window.location.assign('/dashboard');
  }

  trackLocation(_index: number, location: { id: string }): string {
    return location.id;
  }
}
