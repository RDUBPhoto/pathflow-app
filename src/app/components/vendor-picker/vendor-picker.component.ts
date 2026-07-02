import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Vendor, VendorsApiService } from '../../services/vendors-api.service';

@Component({
  selector: 'app-vendor-picker',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './vendor-picker.component.html',
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
    this.loading.set(true);
    this.error.set('');
    this.vendorsApi.create({ name }).subscribe({
      next: res => {
        this.loading.set(false);
        if (res?.vendor) this.selectVendor(res.vendor);
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not add supplier.'));
        this.loading.set(false);
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
}
