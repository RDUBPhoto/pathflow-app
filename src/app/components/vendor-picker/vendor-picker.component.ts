
import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Vendor, VendorPayload, VendorsApiService } from '../../services/vendors-api.service';

@Component({
  selector: 'app-vendor-picker',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './vendor-picker.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./vendor-picker.component.scss']
})
export class VendorPickerComponent implements OnChanges {
  private readonly vendorsApi = inject(VendorsApiService);

  @Input() label = 'Supplier';
  @Input() vendorId = '';
  @Input() vendorName = '';
  @Input() placeholder = 'Search or add supplier';
  @Output() vendorChange = new EventEmitter<{ vendorId: string; vendorName: string; vendor: Vendor | null }>();

  readonly query = signal('');
  readonly vendors = signal<Vendor[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly open = signal(false);
  readonly detailModalOpen = signal(false);
  readonly detailSaving = signal(false);
  readonly detailError = signal('');
  readonly vendorDraft = signal<VendorPayload>({
    name: '',
    contactName: '',
    phone: '',
    email: '',
    website: '',
    accountNumber: '',
    address: '',
    city: '',
    state: '',
    zip: '',
    notes: ''
  });

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['vendorName'] && !this.open()) {
      this.query.set(String(this.vendorName || ''));
    }
  }

  onInput(value: unknown): void {
    const query = String(value || '');
    this.query.set(query);
    this.open.set(true);
    this.vendorChange.emit({ vendorId: '', vendorName: query, vendor: null });
    this.search(query);
  }

  focus(): void {
    this.open.set(true);
    this.search(this.query() || this.vendorName || '');
  }

  selectVendor(vendor: Vendor): void {
    this.query.set(vendor.name);
    this.open.set(false);
    this.vendorChange.emit({ vendorId: vendor.id, vendorName: vendor.name, vendor });
  }

  addVendor(): void {
    const name = this.query().trim();
    if (!name) return;
    this.vendorDraft.set({
      name,
      contactName: '',
      phone: '',
      email: '',
      website: '',
      accountNumber: '',
      address: '',
      city: '',
      state: '',
      zip: '',
      notes: ''
    });
    this.detailError.set('');
    this.detailModalOpen.set(true);
    this.open.set(false);
  }

  closeDetailModal(): void {
    if (this.detailSaving()) return;
    this.detailModalOpen.set(false);
    this.detailError.set('');
  }

  setDraftField<K extends keyof VendorPayload>(field: K, value: VendorPayload[K]): void {
    this.vendorDraft.set({
      ...this.vendorDraft(),
      [field]: String(value || '')
    });
  }

  saveVendorDetails(): void {
    const draft = this.vendorDraft();
    const name = String(draft.name || '').trim();
    if (!name) {
      this.detailError.set('Supplier name is required.');
      return;
    }
    this.detailSaving.set(true);
    this.detailError.set('');
    this.vendorsApi.create({
      ...draft,
      name,
      website: this.normalizeWebsite(draft.website)
    }).subscribe({
      next: res => {
        this.detailSaving.set(false);
        this.detailModalOpen.set(false);
        if (res?.vendor) {
          this.vendors.set([res.vendor, ...this.vendors().filter(vendor => vendor.id !== res.vendor.id)]);
          this.selectVendor(res.vendor);
        }
      },
      error: err => {
        this.detailError.set(String(err?.error?.error || err?.message || 'Could not add supplier.'));
        this.detailSaving.set(false);
      }
    });
  }

  hasExactMatch(): boolean {
    const normalized = this.normalize(this.query());
    return !!normalized && this.vendors().some(vendor => this.normalize(vendor.name) === normalized);
  }

  private search(query: string): void {
    this.loading.set(true);
    this.error.set('');
    this.vendorsApi.list(query).subscribe({
      next: res => {
        this.vendors.set(Array.isArray(res?.vendors) ? res.vendors.slice(0, 8) : []);
        this.loading.set(false);
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not search suppliers.'));
        this.loading.set(false);
      }
    });
  }

  private normalize(value: string): string {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ');
  }

  private normalizeWebsite(value: unknown): string {
    const website = String(value || '').trim();
    if (!website) return '';
    if (/^https?:\/\//i.test(website)) return website;
    return `https://${website}`;
  }
}
