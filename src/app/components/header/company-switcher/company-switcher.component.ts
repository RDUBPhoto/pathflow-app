import { Component, ElementRef, HostListener, ViewChild, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  IonButton,
  IonContent,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonPopover
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  businessOutline,
  checkmarkCircleOutline,
  chevronDownOutline,
  searchOutline
} from 'ionicons/icons';
import { AuthService } from '../../../auth/auth.service';
import { TenantContextService } from '../../../services/tenant-context.service';
import { Router } from '@angular/router';
import { CustomersApi, type Customer } from '../../../services/customers-api.service';
import { InventoryApiService, type InventoryItem } from '../../../services/inventory-api.service';
import { InvoicesDataService, type InvoiceDetail } from '../../../services/invoices-data.service';
import { catchError, forkJoin, map, of } from 'rxjs';

type SearchCategory = 'customers' | 'quotes' | 'invoices' | 'inventory';

type SearchRecord = {
  id: string;
  category: SearchCategory;
  title: string;
  subtitle: string;
  meta: string;
  searchText: string;
  route: any[];
};

type SearchBucket = {
  id: SearchCategory;
  label: string;
  results: SearchRecord[];
};

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
    IonLabel,
    IonModal
  ],
  templateUrl: './company-switcher.component.html',
  styleUrls: ['./company-switcher.component.scss']
})
export class CompanySwitcherComponent {
  @ViewChild('overlayInput') overlayInputRef?: ElementRef<HTMLInputElement>;

  readonly auth = inject(AuthService);
  private readonly tenantContext = inject(TenantContextService);
  private readonly router = inject(Router);
  private readonly customersApi = inject(CustomersApi);
  private readonly inventoryApi = inject(InventoryApiService);
  private readonly invoicesData = inject(InvoicesDataService);

  readonly open = signal(false);
  readonly menuEvent = signal<Event | null>(null);
  readonly locations = computed(() => this.auth.locations());
  readonly activeLocationId = computed(() => this.tenantContext.tenantId());
  readonly show = computed(() => this.auth.isSuperAdmin() || this.locations().length > 1);
  readonly searchOpen = signal(false);
  readonly searchQuery = signal('');
  readonly searchLoading = signal(false);
  readonly searchError = signal('');
  readonly searchIndex = signal<SearchRecord[]>([]);
  private lastIndexLoadedAt = 0;
  private readonly bucketOrder: SearchCategory[] = ['customers', 'quotes', 'invoices', 'inventory'];
  readonly searchBuckets = computed<SearchBucket[]>(() => {
    const query = this.normalize(this.searchQuery());
    const records = this.searchIndex();
    const scored = query
      ? records
        .filter(record => record.searchText.includes(query))
        .map(record => ({ record, score: this.matchScore(record, query) }))
        .sort((a, b) => a.score - b.score || a.record.title.localeCompare(b.record.title))
        .map(item => item.record)
      : [];

    return this.bucketOrder.map(id => ({
      id,
      label: this.bucketLabel(id),
      results: scored.filter(record => record.category === id).slice(0, 8)
    })).filter(bucket => bucket.results.length > 0);
  });
  readonly hasResults = computed(() => this.searchBuckets().some(bucket => bucket.results.length > 0));
  readonly activeLocationName = computed(() => {
    const activeId = this.activeLocationId();
    const locations = this.locations();
    if (!locations.length) return this.auth.isSuperAdmin() ? '-- Empty --' : 'Location';
    return locations.find(location => location.id === activeId)?.name || locations[0]?.name || 'Location';
  });

  constructor() {
    addIcons({
      'business-outline': businessOutline,
      'chevron-down-outline': chevronDownOutline,
      'checkmark-circle-outline': checkmarkCircleOutline,
      'search-outline': searchOutline
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

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    const key = String(event.key || '').toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === 'k') {
      event.preventDefault();
      this.openGlobalSearch();
      return;
    }
    if (key === 'escape' && this.searchOpen()) {
      event.preventDefault();
      this.closeGlobalSearch();
    }
  }

  onTriggerFocus(): void {}

  onTriggerInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    const value = String(target?.value || '').trim();
    if (target) target.value = '';
    this.openGlobalSearch(value);
  }

  openGlobalSearch(seed = ''): void {
    if (!this.searchOpen()) {
      this.searchOpen.set(true);
      this.searchError.set('');
    }
    const normalizedSeed = String(seed || '');
    if (normalizedSeed) this.searchQuery.set(normalizedSeed);
    this.ensureSearchIndex();
    setTimeout(() => this.overlayInputRef?.nativeElement?.focus(), 0);
  }

  closeGlobalSearch(): void {
    this.searchOpen.set(false);
    this.searchQuery.set('');
  }

  onOverlayClick(event: MouseEvent): void {
    if ((event.target as HTMLElement)?.classList?.contains('global-search-overlay')) {
      this.closeGlobalSearch();
    }
  }

  onSearchModalPresented(): void {
    setTimeout(() => this.overlayInputRef?.nativeElement?.focus(), 0);
  }

  onSearchInput(event: Event): void {
    const target = event.target as HTMLInputElement | null;
    this.searchQuery.set(String(target?.value || ''));
  }

  openSearchResult(record: SearchRecord): void {
    this.closeGlobalSearch();
    this.router.navigate(record.route);
  }

  private ensureSearchIndex(): void {
    const now = Date.now();
    if (this.searchIndex().length && now - this.lastIndexLoadedAt < 30000) return;
    this.searchLoading.set(true);
    this.searchError.set('');

    const invoiceDocs = this.invoicesData.invoiceDetails();
    forkJoin({
      customers: this.customersApi.list().pipe(catchError(() => of([] as Customer[]))),
      inventory: this.inventoryApi.listItems().pipe(
        map(res => (Array.isArray(res?.items) ? res.items : []) as InventoryItem[]),
        catchError(() => of([] as InventoryItem[]))
      )
    }).subscribe({
      next: ({ customers, inventory }) => {
        const nextIndex = [
          ...this.customerRecords(customers),
          ...this.invoiceRecords(invoiceDocs),
          ...this.inventoryRecords(inventory)
        ];
        this.searchIndex.set(nextIndex);
        this.lastIndexLoadedAt = Date.now();
        this.searchLoading.set(false);
      },
      error: () => {
        this.searchLoading.set(false);
        this.searchError.set('Search index failed to load.');
      }
    });
  }

  private customerRecords(items: Customer[]): SearchRecord[] {
    return (Array.isArray(items) ? items : []).map(customer => {
      const id = String(customer.id || '').trim();
      const name = String(customer.name || '').trim() || 'Customer';
      const email = String(customer.email || '').trim();
      const phone = String(customer.phone || customer.mobile || '').trim();
      const vehicle = [customer.vehicleYear, customer.vehicleMake, customer.vehicleModel].filter(Boolean).join(' ').trim();
      return {
        id: `customer:${id || name}`,
        category: 'customers',
        title: name,
        subtitle: [email, phone].filter(Boolean).join(' • ') || 'Customer',
        meta: vehicle || 'Open customer profile',
        searchText: this.joinSearch(
          name,
          email,
          phone,
          customer.secondaryEmail,
          customer.address,
          customer.vin,
          customer.vehicleMake,
          customer.vehicleModel,
          customer.vehicleYear,
          customer.vehicleTrim
        ),
        route: id ? ['/customers', id] : ['/customers']
      };
    });
  }

  private invoiceRecords(items: InvoiceDetail[]): SearchRecord[] {
    return (Array.isArray(items) ? items : []).map(invoice => {
      const isQuote = invoice.documentType === 'quote';
      const number = String(invoice.invoiceNumber || '').trim() || (isQuote ? 'Quote' : 'Invoice');
      const customerName = String(invoice.customerName || '').trim();
      const stage = String(invoice.stage || '').trim();
      const total = Number(invoice.total || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD' });
      const lineText = (Array.isArray(invoice.lineItems) ? invoice.lineItems : [])
        .map(line => `${line.code || ''} ${line.description || ''}`)
        .join(' ');
      return {
        id: `${invoice.documentType}:${invoice.id}`,
        category: isQuote ? 'quotes' : 'invoices',
        title: number,
        subtitle: customerName || 'Customer',
        meta: `${stage || 'draft'} • ${total}`,
        searchText: this.joinSearch(
          number,
          customerName,
          invoice.customerEmail,
          invoice.customerPhone,
          invoice.vehicle,
          invoice.description,
          invoice.staffNote,
          invoice.customerNote,
          lineText
        ),
        route: [isQuote ? '/quotes' : '/invoices', invoice.id]
      };
    });
  }

  private inventoryRecords(items: InventoryItem[]): SearchRecord[] {
    return (Array.isArray(items) ? items : []).map(item => {
      const id = String(item.id || '').trim();
      const name = String(item.name || '').trim() || 'Part';
      const sku = String(item.sku || '').trim();
      const vendor = String(item.vendor || '').trim();
      const price = Number(item.price || 0);
      return {
        id: `inventory:${id || sku || name}`,
        category: 'inventory',
        title: name,
        subtitle: [sku, vendor].filter(Boolean).join(' • ') || 'Inventory item',
        meta: price > 0 ? `${price.toLocaleString(undefined, { style: 'currency', currency: 'USD' })} sale price` : 'Open in inventory',
        searchText: this.joinSearch(
          name,
          sku,
          vendor,
          item.category,
          item.accountCode,
          item.purchaseAccountCode
        ),
        route: ['/inventory']
      };
    });
  }

  private bucketLabel(id: SearchCategory): string {
    switch (id) {
      case 'customers': return 'Customers';
      case 'quotes': return 'Quotes';
      case 'invoices': return 'Invoices';
      case 'inventory': return 'Inventory';
      default: return 'Results';
    }
  }

  private matchScore(record: SearchRecord, query: string): number {
    const title = this.normalize(record.title);
    const subtitle = this.normalize(record.subtitle);
    const meta = this.normalize(record.meta);
    if (title.startsWith(query)) return 0;
    if (title.includes(query)) return 1;
    if (subtitle.includes(query)) return 2;
    if (meta.includes(query)) return 3;
    return 4;
  }

  private normalize(value: unknown): string {
    return String(value || '').trim().toLowerCase();
  }

  private joinSearch(...values: unknown[]): string {
    return values
      .map(value => this.normalize(value))
      .filter(Boolean)
      .join(' ');
  }
}
