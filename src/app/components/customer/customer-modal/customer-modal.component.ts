import { Component, Input, Output, EventEmitter, OnInit, OnChanges, SimpleChanges, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonModal, IonHeader, IonToolbar, IonTitle, IonButtons, IonButton,
  IonContent, IonItem, IonLabel, IonInput, IonTextarea, IonList, IonNote, IonSpinner, IonFooter
} from '@ionic/angular/standalone';
import { HttpClient } from '@angular/common/http';
import { CustomersApi, Customer } from '../../../services/customers-api.service';

type ColorOpt = { label: string; hex: string };
type Mode = 'add' | 'edit';
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
  selector: 'app-customer-modal',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    IonHeader, IonToolbar, IonTitle, IonButtons, IonButton,
    IonContent, IonItem, IonLabel, IonInput, IonTextarea, IonList, IonNote, IonSpinner, IonFooter
  ],
  templateUrl: './customer-modal.component.html',
  styleUrls: ['./customer-modal.component.scss']
})
export default class CustomerModalComponent implements OnInit, OnChanges {
  @Input() isOpen: boolean = false;
  @Input() mode: Mode = 'add';
  @Input() customerId: string | null = null;
  @Input() laneId: string | null = null;
  @Input() initialNotes: string | null = null;

  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<{ id: string }>();

  loading = signal(false);
  status = signal('');
  loadingForm = signal<boolean>(false);
  showErrors = signal<boolean>(false);
  private initialFormSnapshot = signal('');

  allCustomers = signal<Customer[]>([]);
  dupMatches = signal<Customer[]>([]);
  selectedExistingId = signal<string | null>(null);

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
  formDirty = computed(() => this.formSnapshotValue() !== this.initialFormSnapshot());
  canSave = computed(() =>
    this.nameValid() &&
    this.phoneValid() &&
    this.emailValid() &&
    this.addressValid() &&
    this.vehicleMakeValid() &&
    this.vehicleModelValid() &&
    this.vehicleYearValid() &&
    this.vinValid() &&
    this.formDirty()
  );
  hasVinDetails = computed(() => Object.values(this.vinDecoded()).some(v => !!v));

  constructor(private api: CustomersApi, private http: HttpClient) {}

  ngOnInit() {
    this.loadAllCustomers();

    if (this.mode === 'add') {
      this.loadingForm.set(false);
      this.resetFormForAdd();
    } else if (this.mode === 'edit' && this.customerId) {
      this.loadingForm.set(true);
      this.loadCustomer(this.customerId);
    }
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['mode'] || changes['customerId']) {
      if (this.mode === 'edit' && this.customerId) {
        this.loadingForm.set(true);
        this.loadCustomer(this.customerId);
      } else {
        this.loadingForm.set(false);
        this.resetFormForAdd();
      }
    }
  }

  close() { this.closed.emit(); }

  onFirstChange(v: string) { this.firstName.set(v ?? ''); this.recomputeDupMatches(); }
  onLastChange(v: string) { this.lastName.set(v ?? ''); this.recomputeDupMatches(); }
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
  onEmailChange(v: string) { this.email.set(v ?? ''); this.recomputeDupMatches(); }
  onVinChange(v: string) { this.vin.set((v || '').toUpperCase().replace(/[^A-Z0-9]/g, '')); }

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
    this.address.set(ext['address'] || '');
    this.vin.set(ext['vin'] || '');
    this.vehicleMake.set(ext['vehicleMake'] || '');
    this.vehicleModel.set(ext['vehicleModel'] || '');
    this.vehicleYear.set(ext['vehicleYear'] || '');
    this.vehicleTrim.set(ext['vehicleTrim'] || '');
    this.vehicleDoors.set(ext['vehicleDoors'] || '');
    this.bedLength.set(ext['bedLength'] || '');
    this.cabType.set(ext['cabType'] || '');
    this.engineModel.set(ext['engineModel'] || '');
    this.engineCylinders.set(ext['engineCylinders'] || '');
    this.transmissionStyle.set(ext['transmissionStyle'] || '');
    this.vehicleColor.set(ext['vehicleColor'] || '');
    this.notes.set(ext['notes'] || '');
    this.selectedExistingId.set(d.id);
  }

  save() {
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

    const payload: UICustomer =
      (this.mode === 'edit' && this.customerId)
        ? { ...(base as UICustomer), id: this.customerId }
        : { ...(base as UICustomer), id: '', createdAt: new Date().toISOString() };

    this.status.set('Saving');
    this.api.upsert(payload).subscribe({
      next: res => {
        const id = res.id;
        this.saved.emit({ id });
        this.resetStateAfterSave();
      },
      error: () => this.status.set('Save error')
    });
  }

  private loadCustomer(id: string) {
    this.loadingForm.set(true);

    this.api.list().subscribe({
      next: (cs: Customer[]) => {
        const found = (cs as UICustomer[]).find((c: UICustomer) => c.id === id);
        if (found) {
          this.fillFormFromCustomer(found);
          if (!this.notes().trim() && (this.initialNotes ?? '').trim()) {
            this.notes.set(this.initialNotes!.trim());
          }
        }
        this.loadingForm.set(false);
      },
      error: () => {
        this.loadingForm.set(false);
      }
    });
  }

  private resetStateAfterSave() {
    this.showErrors.set(false);
    this.status.set('Saved');
    this.markFormPristine();
  }

  private loadAllCustomers() {
    this.api.list().subscribe({
      next: cs => this.allCustomers.set(cs),
      error: () => {}
    });
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
    this.showErrors.set(false);
    this.markFormPristine();
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
    this.address.set((c as any)['address'] || '');
    this.vin.set((c as any)['vin'] || '');
    this.vehicleMake.set((c as any)['vehicleMake'] || '');
    this.vehicleModel.set((c as any)['vehicleModel'] || '');
    this.vehicleYear.set((c as any)['vehicleYear'] || '');
    this.vehicleTrim.set((c as any)['vehicleTrim'] || '');
    this.vehicleDoors.set((c as any)['vehicleDoors'] || '');
    this.bedLength.set((c as any)['bedLength'] || '');
    this.cabType.set((c as any)['cabType'] || '');
    this.engineModel.set((c as any)['engineModel'] || '');
    this.engineCylinders.set((c as any)['engineCylinders'] || '');
    this.transmissionStyle.set((c as any)['transmissionStyle'] || '');
    this.vehicleColor.set((c as any)['vehicleColor'] || '');
    this.notes.set((c as any)['notes'] || '');
    this.vinDecoded.set({});
    this.vinStatus.set('');
    this.showErrors.set(false);
    this.markFormPristine();
  }

  private formSnapshotValue(): string {
    return JSON.stringify({
      firstName: this.firstName().trim(),
      lastName: this.lastName().trim(),
      phone: this.phone().trim(),
      email: this.email().trim().toLowerCase(),
      address: this.address().trim(),
      notes: this.notes().trim(),
      vin: this.vin().trim().toUpperCase(),
      vehicleMake: this.vehicleMake().trim(),
      vehicleModel: this.vehicleModel().trim(),
      vehicleYear: this.vehicleYear().trim(),
      vehicleTrim: this.vehicleTrim().trim(),
      vehicleDoors: this.vehicleDoors().trim(),
      bedLength: this.bedLength().trim(),
      cabType: this.cabType().trim(),
      engineModel: this.engineModel().trim(),
      engineCylinders: this.engineCylinders().trim(),
      transmissionStyle: this.transmissionStyle().trim(),
      vehicleColor: this.vehicleColor().trim()
    });
  }

  private markFormPristine(): void {
    this.initialFormSnapshot.set(this.formSnapshotValue());
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
    const all = this.allCustomers();
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
  private resetFormForAdd(): void {
    this.clearForm();
  }

  private patchFormFromCustomer(c: Customer): void {
    this.fillFormFromCustomer(c as any);
  }
}
