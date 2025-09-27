import { Component, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonHeader, IonToolbar, IonTitle, IonContent,
  IonList, IonItem, IonLabel, IonInput, IonButton
} from '@ionic/angular/standalone';
import { CustomersApi, Customer } from '../../services/customers-api.service';

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

  constructor(private api: CustomersApi) {
    this.refresh();
  }

  refresh() {
    this.loading.set(true);
    this.api.list().subscribe({
      next: rows => { this.customers.set(rows); this.loading.set(false); },
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
      error: err => this.status.set(`Save error ${err?.status || ''}`)
    });
  }
}
