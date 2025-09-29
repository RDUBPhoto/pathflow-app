import { Component, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import {
  IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton,
  IonList, IonItem, IonLabel, IonInput, IonSpinner, IonTextarea, IonModal, IonNote
} from '@ionic/angular/standalone';
import { CustomersApi, Customer } from '../../services/customers-api.service';

type SortKey = 'name' | 'phone' | 'email';
type SortDir = 'asc' | 'desc';
type ColorOpt = { label: string; hex: string };
type UICustomer = Customer & {
  createdAt?: string;
  address?: string;
  vin?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleYear?: string;
  vehicleTrim?: string;
  vehicleDoors?: string;
  bedLength?: string;
  cabType?: string;
  engineModel?: string;
  engineCylinders?: string;
  transmissionStyle?: string;
  vehicleColor?: string;
  notes?: string;
  firstName?: string;
  lastName?: string;
};

@Component({
  selector: 'app-customers',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton,
    IonList, IonItem, IonLabel, IonInput, IonSpinner, IonTextarea, IonModal, IonNote
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

  addOpen = signal<boolean>(false);
  editMode = signal<boolean>(false);
  editId = signal<string | null>(null);
  editCreatedAt = signal<string | undefined>(undefined);

  firstName = signal<string>('');
  lastName = signal<string>('');
  phone = signal<string>('');
  email = signal<string>('');
  address = signal<string>('');
  notes = signal<string>('');

  vin = signal<string>('');
  vinStatus = signal<string>('');
  vinDecoded = signal<Record<string, string>>({});

  vehicleMake = signal<string>('');
  vehicleModel = signal<string>('');
  vehicleYear = signal<string>('');
  vehicleTrim = signal<string>('');
  vehicleDoors = signal<string>('');
  bedLength = signal<string>('');
  cabType = signal<string>('');
  engineModel = signal<string>('');
  engineCylinders = signal<string>('');
  transmissionStyle = signal<string>('');
  vehicleColor = signal<string>('');

  palette: ColorOpt[] = [
    { label: 'White',  hex: '#ffffff' },
    { label: 'Black',  hex: '#000000' },
    { label: 'Silver', hex: '#c0c0c0' },
    { label: 'Gray',   hex: '#808080' },
    { label: 'Red',    hex: '#d32f2f' },
    { label: 'Blue',   hex: '#1976d2' },
    { label: 'Green',  hex: '#388e3c' },
    { label: 'Yellow', hex: '#fbc02d' },
    { label: 'Orange', hex: '#f57c00' },
    { label: 'Brown',  hex: '#795548' }
  ];

  showErrors = signal<boolean>(false);

  dupMatches = signal<Customer[]>([]);
  selectedExistingId = signal<string | null>(null);

  phoneValid = computed(() => this.normalizePhone(this.phone()).length >= 10);
  emailValid = computed(() => this.email().trim() !== '' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email().trim()));
  nameValid = computed(() => !!this.firstName().trim() && !!this.lastName().trim());
  addressValid = computed(() => this.address().trim().length >= 3);
  vehicleMakeValid = computed(() => !!this.vehicleMake().trim());
  vehicleModelValid = computed(() => !!this.vehicleModel().trim());
  vehicleYearValid = computed(() => {
    const y = this.vehicleYear().trim();
    if (!/^\d{4}$/.test(y)) return false;
    const n = +y;
    const now = new Date().getFullYear();
    return n >= 1950 && n <= now + 1;
  });
  vinValid = computed(() => {
    const v = this.vin().trim().toUpperCase();
    if (!v) return true;
    return /^[A-HJ-NPR-Z0-9]{17}$/.test(v);
  });
  canSave = computed(() =>
    this.nameValid() &&
    this.phoneValid() &&
    this.emailValid() &&
    this.addressValid() &&
    this.vehicleMakeValid() &&
    this.vehicleModelValid() &&
    this.vehicleYearValid() &&
    this.vinValid()
  );
  hasVinDetails = computed(() => Object.values(this.vinDecoded()).some(v => !!v));

  filtered = computed(() => {
    const arr = this.customers().slice();
    const key = this.sortKey();
    const dir = this.sortDir() === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      const av = ((a as any)[key] || '').toString().toLowerCase();
      const bv = ((b as any)[key] || '').toString().toLowerCase();
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return arr;
  });

  constructor(private api: CustomersApi, private http: HttpClient) {
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

  openAdd() {
    this.clearForm();
    this.editMode.set(false);
    this.editId.set(null);
    this.editCreatedAt.set(undefined);
    this.showErrors.set(false);
    this.addOpen.set(true);
  }

  openEdit(c: UICustomer) {
    this.fillFormFromCustomer(c);
    this.editMode.set(true);
    this.editId.set(c.id);
    this.editCreatedAt.set(c.createdAt);
    this.addOpen.set(true);
  }

  cancelAdd() {
    this.addOpen.set(false);
    this.showErrors.set(false);
  }

  onFirstChange(v: string) {
    this.firstName.set(v ?? '');
    this.recomputeDupMatches();
  }

  onLastChange(v: string) {
    this.lastName.set(v ?? '');
    this.recomputeDupMatches();
  }

  onPhoneInput(v: string) {
    const digits = (v || '').replace(/\D+/g, '').slice(0, 15);
    let pretty = digits;
    if (digits.length >= 10) {
      const d = digits.slice(-10);
      pretty = `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6,10)}` + (digits.length > 10 ? ` x${digits.slice(10)}` : '');
    } else if (digits.length > 6) {
      pretty = `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`;
    } else if (digits.length > 3) {
      pretty = `(${digits.slice(0,3)}) ${digits.slice(3)}`;
    }
    this.phone.set(pretty);
    this.recomputeDupMatches();
  }

  onEmailChange(v: string) {
    this.email.set(v ?? '');
    this.recomputeDupMatches();
  }

  onVinChange(v: string) {
    const raw = (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    this.vin.set(raw);
  }

  lookupVIN() {
    const vin = this.vin().trim().toUpperCase();
    if (!vin) { this.vinStatus.set(''); this.vinDecoded.set({}); return; }
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) { this.vinStatus.set('Invalid VIN'); this.vinDecoded.set({}); return; }
    this.vinStatus.set('Decoding…');
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`;
    this.http.get<any>(url).subscribe({
      next: res => {
        const r = res?.Results?.[0] || {};
        const make = (r.Make || '').toString().trim();
        const model = (r.Model || '').toString().trim();
        const year = (r.ModelYear || '').toString().trim();
        const trim = (r.Trim || '').toString().trim();
        const doors = (r.Doors || '').toString().trim();
        const bedLen = (r.BedLength || '').toString().trim();
        const cab = (r.CabType || '').toString().trim();
        const engModel = (r.EngineModel || '').toString().trim();
        const engCyl = (r.EngineCylinders || '').toString().trim();
        const trans = (r.TransmissionStyle || '').toString().trim();
        if (make) this.vehicleMake.set(make);
        if (model) this.vehicleModel.set(model);
        if (year) this.vehicleYear.set(year);
        if (trim) this.vehicleTrim.set(trim);
        if (doors) this.vehicleDoors.set(doors);
        if (bedLen) this.bedLength.set(bedLen);
        if (cab) this.cabType.set(cab);
        if (engModel) this.engineModel.set(engModel);
        if (engCyl) this.engineCylinders.set(engCyl);
        if (trans) this.transmissionStyle.set(trans);
        const decoded: Record<string,string> = {
          Make: make,
          Model: model,
          ModelYear: year,
          Trim: trim,
          Doors: doors,
          BedLength: bedLen,
          CabType: cab,
          EngineModel: engModel,
          EngineCylinders: engCyl,
          TransmissionStyle: trans
        };
        this.vinDecoded.set(decoded);
        this.vinStatus.set('VIN decoded');
      },
      error: () => { this.vinDecoded.set({}); this.vinStatus.set('VIN lookup error'); }
    });
  }

  selectDuplicate(d: Customer) {
    const full = (d.name || '').trim();
    const parts = full.split(/\s+/);
    const first = parts.slice(0, -1).join(' ') || parts[0] || '';
    const last = parts.length > 1 ? parts[parts.length - 1] : '';
    this.firstName.set(first);
    this.lastName.set(last);
    this.phone.set(d.phone || '');
    this.email.set(d.email || '');
    const ext = d as any as UICustomer;
    this.address.set(ext.address || '');
    this.vin.set(ext.vin || '');
    this.vehicleMake.set(ext.vehicleMake || '');
    this.vehicleModel.set(ext.vehicleModel || '');
    this.vehicleYear.set(ext.vehicleYear || '');
    this.vehicleTrim.set(ext.vehicleTrim || '');
    this.vehicleDoors.set(ext.vehicleDoors || '');
    this.bedLength.set(ext.bedLength || '');
    this.cabType.set(ext.cabType || '');
    this.engineModel.set(ext.engineModel || '');
    this.engineCylinders.set(ext.engineCylinders || '');
    this.transmissionStyle.set(ext.transmissionStyle || '');
    this.vehicleColor.set(ext.vehicleColor || '');
    this.notes.set(ext.notes || '');
    this.selectedExistingId.set(d.id);
  }

  saveAdd() {
    if (!this.canSave()) { this.showErrors.set(true); this.status.set('Please complete required fields'); return; }
    const name = `${this.firstName().trim()} ${this.lastName().trim()}`.trim();
    const base: Partial<UICustomer> = {
      name,
      firstName: this.firstName().trim(),
      lastName: this.lastName().trim(),
      phone: this.phone().trim(),
      email: this.email().trim(),
      address: this.address().trim(),
      vin: this.vin().trim() || undefined,
      vehicleMake: this.vehicleMake().trim() || undefined,
      vehicleModel: this.vehicleModel().trim() || undefined,
      vehicleYear: this.vehicleYear().trim() || undefined,
      vehicleTrim: this.vehicleTrim().trim() || undefined,
      vehicleDoors: this.vehicleDoors().trim() || undefined,
      bedLength: this.bedLength().trim() || undefined,
      cabType: this.cabType().trim() || undefined,
      engineModel: this.engineModel().trim() || undefined,
      engineCylinders: this.engineCylinders().trim() || undefined,
      transmissionStyle: this.transmissionStyle().trim() || undefined,
      vehicleColor: this.vehicleColor().trim() || undefined,
      notes: this.notes().trim()
    };

    let payload: UICustomer;
    if (this.editMode() && this.editId()) {
      payload = { ...(base as UICustomer), id: this.editId()!, createdAt: this.editCreatedAt() };
    } else {
      payload = { ...(base as UICustomer), id: '', createdAt: new Date().toISOString() };
    }

    this.status.set('Saving');
    this.api.upsert(payload).subscribe({
      next: res => {
        const id = res.id;
        const list = this.customers().slice();
        if (this.editMode() && this.editId()) {
          const idx = list.findIndex(x => x.id === this.editId());
          if (idx >= 0) list[idx] = { ...list[idx], ...payload, id };
          this.customers.set(list);
        } else {
          list.unshift({ ...payload, id });
          this.customers.set(list);
        }
        this.addOpen.set(false);
        this.clearForm();
        this.editMode.set(false);
        this.editId.set(null);
        this.editCreatedAt.set(undefined);
        this.showErrors.set(false);
        this.status.set('Saved');
      },
      error: (err: HttpErrorResponse) => this.status.set(`Save error ${err?.status ?? 'unknown'}`)
    });
  }

  vehicleSummaryFor(c: UICustomer): string {
    const parts: string[] = [];
    if (c.vehicleYear) parts.push(c.vehicleYear);
    if (c.vehicleMake) parts.push(c.vehicleMake);
    if (c.vehicleModel) parts.push(c.vehicleModel);
    return parts.join(' ');
  }

  trackCustomer(_i: number, c: UICustomer) {
    return c.id;
  }

  colorLabel(hex: string): string {
    const m = this.palette.find(p => p.hex.toLowerCase() === (hex || '').toLowerCase());
    return m?.label || hex || '—';
  }

  private clearForm() {
    this.firstName.set('');
    this.lastName.set('');
    this.phone.set('');
    this.email.set('');
    this.address.set('');
    this.notes.set('');
    this.vin.set('');
    this.vinStatus.set('');
    this.vinDecoded.set({});
    this.vehicleMake.set('');
    this.vehicleModel.set('');
    this.vehicleYear.set('');
    this.vehicleTrim.set('');
    this.vehicleDoors.set('');
    this.bedLength.set('');
    this.cabType.set('');
    this.engineModel.set('');
    this.engineCylinders.set('');
    this.transmissionStyle.set('');
    this.vehicleColor.set('');
    this.dupMatches.set([]);
    this.selectedExistingId.set(null);
  }

  private fillFormFromCustomer(c: UICustomer) {
    const full = (c.name || '').trim();
    const parts = full.split(/\s+/);
    const first = c.firstName || parts.slice(0, -1).join(' ') || parts[0] || '';
    const last = c.lastName || (parts.length > 1 ? parts[parts.length - 1] : '');
    this.firstName.set(first);
    this.lastName.set(last);
    this.phone.set(c.phone || '');
    this.email.set(c.email || '');
    this.address.set(c.address || '');
    this.vin.set(c.vin || '');
    this.vehicleMake.set(c.vehicleMake || '');
    this.vehicleModel.set(c.vehicleModel || '');
    this.vehicleYear.set(c.vehicleYear || '');
    this.vehicleTrim.set(c.vehicleTrim || '');
    this.vehicleDoors.set(c.vehicleDoors || '');
    this.bedLength.set(c.bedLength || '');
    this.cabType.set(c.cabType || '');
    this.engineModel.set(c.engineModel || '');
    this.engineCylinders.set(c.engineCylinders || '');
    this.transmissionStyle.set(c.transmissionStyle || '');
    this.vehicleColor.set(c.vehicleColor || '');
    this.notes.set(c.notes || '');
    this.vinDecoded.set({});
    this.vinStatus.set('');
    this.showErrors.set(false);
  }

  private normalizePhone(v: string): string {
    const s = (v || '').replace(/\D+/g, '');
    if (s.length >= 10) return s.slice(-10);
    if (s.length >= 7) return s.slice(-7);
    return s;
  }

  private emailsClose(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  private phonesClose(a?: string, b?: string): boolean {
    const na = this.normalizePhone(a || '');
    const nb = this.normalizePhone(b || '');
    return !!na && na === nb;
  }

  private namesClose(a?: string, b?: string): boolean {
    if (!a || !b) return false;
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }

  private recomputeDupMatches(): void {
    const all = this.customers() as Customer[];
    if (!all || !all.length) {
      this.dupMatches.set([]);
      return;
    }
    const phone = this.phone().trim();
    const email = this.email().trim();
    const full = `${this.firstName().trim()} ${this.lastName().trim()}`.trim();
    const list: Customer[] = [];
    for (const c of all) {
      const byPhone = this.normalizePhone(phone).length >= 7 ? this.phonesClose(c.phone, phone) : false;
      const byEmail = email.includes('@') ? this.emailsClose(c.email, email) : false;
      const byName = full ? this.namesClose((c as any).name, full) : false;
      if (byPhone || byEmail || byName) list.push(c);
      if (list.length >= 5) break;
    }
    this.dupMatches.set(list);
  }
}