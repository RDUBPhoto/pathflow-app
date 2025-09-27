import { Component, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import {
  IonHeader, IonToolbar, IonTitle, IonContent,
  IonList, IonItem, IonLabel, IonInput, IonButton
} from '@ionic/angular/standalone';
import { CustomersApi, Customer } from '../../services/customers-api.service';
import { WorkItemsApi, WorkItem } from '../../services/workitems-api.service';
import { forkJoin } from 'rxjs';

@Component({
  selector: 'app-customers',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    IonHeader, IonToolbar, IonTitle, IonContent,
    IonList, IonItem, IonLabel, IonInput, IonButton
  ],
  templateUrl: './customers.component.html',
  styleUrls: ['./customers.component.scss']
})
export default class CustomersComponent {
  customers = signal<Customer[]>([]);
  loading = signal<boolean>(false);
  name = signal<string>('');
  phone = signal<string>('');
  email = signal<string>('');
  status = signal<string>('');
  vehiclesByCustomer = signal<Record<string, { name: string; color?: string }[]>>({});

  constructor(private api: CustomersApi, private itemsApi: WorkItemsApi) {
    this.refresh();
  }

  refresh() {
    this.loading.set(true);
    forkJoin({
      customers: this.api.list(),
      items: this.itemsApi.list()
    }).subscribe({
      next: ({ customers, items }) => {
        this.customers.set(customers);
        this.rebuildVehiclesMap(customers, items);
        this.loading.set(false);
      },
      error: err => { this.status.set(`Load error ${err?.status || ''}`); this.loading.set(false); }
    });
  }

  add() {
    const payload = { name: this.name(), phone: this.phone(), email: this.email() };
    if (!payload.name) { this.status.set('Name required'); return; }
    this.status.set('Saving…');
    this.api.upsert(payload).subscribe({
      next: _ => {
        this.name.set(''); this.phone.set(''); this.email.set('');
        this.status.set('Saved');
        this.refresh();
      },
      error: (err: HttpErrorResponse) => this.status.set(`Save error ${err?.status ?? 'unknown'}`)
    });
  }

  private vehicleFrom(title: string): string {
    const m = (title || '').match(/\(([^)]+)\)/);
    return m?.[1]?.trim() || '';
  }

  private colorFrom(title: string): string | undefined {
    const m = (title || '').match(/\[c=([^\]]+)\]/);
    const v = m?.[1]?.trim();
    return v || undefined;
  }

  private rebuildVehiclesMap(customers: Customer[], items: WorkItem[]) {
    const m: Record<string, { name: string; color?: string }[]> = {};
    for (const c of customers) m[c.id] = [];
    const seen: Record<string, Set<string>> = {};
    for (const it of items) {
      const cid = (it.customerId || '').trim();
      if (!cid || !m.hasOwnProperty(cid)) continue;
      const name = this.vehicleFrom(it.title || '');
      if (!name) continue;
      const color = this.colorFrom(it.title || '');
      const key = color ? `${name}|${color}` : name;
      if (!seen[cid]) seen[cid] = new Set();
      if (seen[cid].has(key)) continue;
      seen[cid].add(key);
      m[cid].push({ name, color });
    }
    this.vehiclesByCustomer.set(m);
  }

}
