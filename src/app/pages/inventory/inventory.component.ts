import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonTitle,
  IonToggle,
  IonToolbar
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  alertCircleOutline,
  businessOutline,
  cartOutline,
  cubeOutline
} from 'ionicons/icons';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import {
  InventoryApiService,
  InventoryItem,
  InventoryNeed
} from '../../services/inventory-api.service';
import { PurchaseOrdersApiService } from '../../services/purchase-orders-api.service';

@Component({
  selector: 'app-inventory',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonContent,
    IonButton,
    IonIcon,
    IonItem,
    IonLabel,
    IonInput,
    IonToggle,
    IonBadge,
    PageBackButtonComponent,
    UserMenuComponent,
    CompanySwitcherComponent
  ],
  templateUrl: './inventory.component.html',
  styleUrls: ['./inventory.component.scss']
})
export default class InventoryComponent implements OnInit {
  private readonly inventoryApi = inject(InventoryApiService);
  private readonly purchaseOrdersApi = inject(PurchaseOrdersApiService);

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly status = signal('');
  readonly error = signal('');
  readonly search = signal('');
  readonly showLowStockOnly = signal(false);
  readonly items = signal<InventoryItem[]>([]);
  readonly jobPartNeeds = signal<InventoryNeed[]>([]);

  readonly lowStockCount = computed(() => this.items().filter(item => this.stockState(item) !== 'ok').length);
  readonly totalOnHand = computed(() => this.items().reduce((sum, item) => sum + item.onHand, 0));
  readonly totalOnOrder = computed(() => this.items().reduce((sum, item) => sum + item.onOrder, 0));
  readonly totalInventoryValue = computed(() =>
    this.items().reduce((sum, item) => sum + (item.onHand * item.unitCost), 0)
  );
  readonly pendingJobNeeds = computed(() =>
    this.jobPartNeeds().filter(item => item.status === 'needs-order' || item.status === 'po-draft')
  );
  readonly filteredItems = computed(() => {
    const query = this.search().trim().toLowerCase();
    const showLow = this.showLowStockOnly();
    return this.items().filter(item => {
      if (showLow && this.stockState(item) === 'ok') return false;
      if (!query) return true;
      const haystack = [
        item.name,
        item.sku,
        item.vendor,
        item.category
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  });

  constructor() {
    addIcons({
      'cube-outline': cubeOutline,
      'alert-circle-outline': alertCircleOutline,
      'cart-outline': cartOutline,
      'business-outline': businessOutline
    });
  }

  ngOnInit(): void {
    this.loadInventoryState();
  }

  loadInventoryState(): void {
    this.loading.set(true);
    this.error.set('');
    this.inventoryApi.getState().subscribe({
      next: res => {
        this.items.set(Array.isArray(res.items) ? res.items : []);
        this.jobPartNeeds.set(Array.isArray(res.needs) ? res.needs : []);
        this.loading.set(false);
      },
      error: err => {
        this.error.set(this.extractError(err, 'Could not load inventory.'));
        this.loading.set(false);
      }
    });
  }

  stockState(item: InventoryItem): 'ok' | 'low' | 'on-order' {
    if (item.onHand > item.reorderAt) return 'ok';
    if (item.onOrder > 0) return 'on-order';
    return 'low';
  }

  stockStateLabel(item: InventoryItem): string {
    const state = this.stockState(item);
    if (state === 'ok') return 'In stock';
    if (state === 'on-order') return 'Reorder placed';
    return 'Needs reorder';
  }

  stockStateClass(item: InventoryItem): string {
    const state = this.stockState(item);
    if (state === 'ok') return 'stock-ok';
    if (state === 'on-order') return 'stock-on-order';
    return 'stock-low';
  }

  needStatusLabel(item: InventoryNeed): string {
    if (item.status === 'needs-order') return 'Needs order';
    if (item.status === 'po-draft') return 'PO draft';
    if (item.status === 'ordered') return 'Ordered';
    if (item.status === 'received') return 'Received';
    if (item.status === 'cancelled') return 'Cancelled';
    return item.status;
  }

  needStatusClass(item: InventoryNeed): string {
    if (item.status === 'needs-order') return 'stock-low';
    if (item.status === 'po-draft') return 'stock-on-order';
    if (item.status === 'ordered') return 'stock-on-order';
    if (item.status === 'received') return 'stock-ok';
    if (item.status === 'cancelled') return 'stock-cancelled';
    return '';
  }

  createReorderDraft(item: InventoryItem): void {
    const qty = Math.max(1, item.reorderAt - item.onHand);
    this.saving.set(true);
    this.error.set('');
    this.purchaseOrdersApi.createDraft({
      supplier: item.vendor || 'Unassigned Supplier',
      note: `Auto-draft reorder for ${item.name}`,
      lines: [
        {
          itemId: item.id,
          partName: item.name,
          sku: item.sku,
          vendor: item.vendor,
          qty,
          unitCost: item.unitCost
        }
      ]
    }).subscribe({
      next: res => {
        this.status.set(`Draft PO ${res.order.id.slice(0, 8)} created for ${item.name}.`);
        this.saving.set(false);
        this.loadInventoryState();
      },
      error: err => {
        this.error.set(this.extractError(err, 'Could not create reorder draft.'));
        this.saving.set(false);
      }
    });
  }

  createPOBatchFromNeeds(): void {
    const needIds = this.jobPartNeeds()
      .filter(item => item.status === 'needs-order')
      .map(item => item.id);
    if (!needIds.length) {
      this.status.set('No needs are waiting for order.');
      return;
    }
    this.saving.set(true);
    this.error.set('');
    this.purchaseOrdersApi.createDraft({
      supplier: 'Mixed Suppliers',
      note: 'Auto-draft generated from schedule-linked inventory needs.',
      needIds
    }).subscribe({
      next: res => {
        this.status.set(`Draft PO ${res.order.id.slice(0, 8)} created from ${needIds.length} need(s).`);
        this.saving.set(false);
        this.loadInventoryState();
      },
      error: err => {
        this.error.set(this.extractError(err, 'Could not create PO draft.'));
        this.saving.set(false);
      }
    });
  }

  formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2
    }).format(value);
  }

  formatDateTime(value: string): string {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return value;
    return new Date(timestamp).toLocaleString();
  }

  trackInventoryItem(_index: number, item: InventoryItem): string {
    return item.id;
  }

  trackJobNeed(_index: number, item: InventoryNeed): string {
    return item.id;
  }

  private extractError(err: any, fallback: string): string {
    return String(err?.error?.error || err?.error?.detail || err?.message || fallback);
  }
}
