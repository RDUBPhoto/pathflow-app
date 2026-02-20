import { Component, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonHeader, IonToolbar, IonTitle, IonContent, IonButton,
  IonButtons,
  IonItem, IonLabel, IonInput, IonSpinner
} from '@ionic/angular/standalone';
import { Router } from '@angular/router';
import { CustomersApi, Customer } from '../../services/customers-api.service';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';

type SortKey = 'name' | 'phone' | 'email';
type SortDir = 'asc' | 'desc';

type UICustomer = Customer & {
  createdAt?: string;
  vehicleYear?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleTrim?: string;
};

@Component({
  selector: 'app-customers',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    IonHeader, IonToolbar, IonTitle, IonContent, IonButton,
    IonButtons,
    IonItem, IonLabel, IonInput, IonSpinner,
    UserMenuComponent,
    PageBackButtonComponent,
    CompanySwitcherComponent
  ],
  templateUrl: './customers.component.html',
  styleUrls: ['./customers.component.scss']
})
export default class CustomersComponent {
  customers = signal<UICustomer[]>([]);
  loading = signal<boolean>(false);
  status = signal<string>('');

  sortKey = signal<SortKey>('name');
  sortDir = signal<SortDir>('asc');
  searchTerm = signal<string>('');

  filtered = computed(() => {
    const key = this.sortKey();
    const dir = this.sortDir() === 'asc' ? 1 : -1;
    const q = this.searchTerm().trim().toLowerCase();
    let arr = this.customers().slice();
    if (q) {
      arr = arr.filter(c => {
        const f1 = (c.name || '').toLowerCase();
        const f2 = (c.phone || '').toLowerCase();
        const f3 = (c.email || '').toLowerCase();
        const f4 = (c.vehicleYear || '').toLowerCase();
        const f5 = (c.vehicleMake || '').toLowerCase();
        const f6 = (c.vehicleModel || '').toLowerCase();
        const f7 = (c.vehicleTrim || '').toLowerCase();
        return f1.includes(q) || f2.includes(q) || f3.includes(q) || f4.includes(q) || f5.includes(q) || f6.includes(q) || f7.includes(q);
      });
    }
    arr.sort((a, b) => {
      const av = ((a as any)[key] || '').toString().toLowerCase();
      const bv = ((b as any)[key] || '').toString().toLowerCase();
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return arr;
  });

  constructor(private api: CustomersApi, private router: Router) {
    this.refresh();
  }

  refresh() {
    this.loading.set(true);
    this.status.set('');
    this.api.list().subscribe({
      next: customers => {
        this.customers.set(customers as UICustomer[]);
        this.loading.set(false);
      },
      error: err => {
        this.status.set(`Load error ${err?.status || ''}`);
        this.loading.set(false);
      }
    });
  }

  setSort(k: SortKey) {
    if (this.sortKey() === k) {
      this.sortDir.set(this.sortDir() === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortKey.set(k);
      this.sortDir.set('asc');
    }
  }

  onSearchChange(v: string) {
    this.searchTerm.set(v ?? '');
  }

  clearSearch() {
    this.searchTerm.set('');
  }

  openAdd() {
    this.router.navigate(['/customers/new']);
  }

  openEdit(c: UICustomer) {
    this.router.navigate(['/customers', c.id]);
  }

  vehicleSummaryFor(c: UICustomer): string {
    const parts: string[] = [];
    if (c.vehicleYear) parts.push(String(c.vehicleYear));
    if (c.vehicleMake) parts.push(String(c.vehicleMake));
    if (c.vehicleModel) parts.push(String(c.vehicleModel));
    return parts.join(' ');
  }

  trackCustomer(_i: number, c: UICustomer) {
    return c.id;
  }
}
