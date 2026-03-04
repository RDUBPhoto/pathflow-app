import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
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
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  carOutline,
  calendarOutline,
  chatbubbleEllipsesOutline,
  addOutline,
  documentTextOutline,
  mailOutline,
  paperPlaneOutline,
  personOutline,
  arrowBackOutline,
  saveOutline,
  cashOutline,
  trashOutline
} from 'ionicons/icons';
import { Subscription, finalize, firstValueFrom } from 'rxjs';
import { CustomersApi, Customer, DuplicateCandidate, DuplicateReason } from '../../services/customers-api.service';
import { SmsApiService, SmsDeliveryStatus, SmsMessage } from '../../services/sms-api.service';
import { EmailApiService, EmailMessage, EmailTemplate } from '../../services/email-api.service';
import { AppSettingsApiService } from '../../services/app-settings-api.service';
import { ScheduleApi, ScheduleItem } from '../../services/schedule-api.service';
import { InvoiceCard, InvoicesDataService } from '../../services/invoices-data.service';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { formatLocalDateTime, toLocalDateTimeInput, toLocalDateTimeStorage } from '../../utils/datetime-local';

type CustomerTab = 'notes' | 'schedule' | 'invoices' | 'sms' | 'email';
type CustomerMobileTab = 'profile' | CustomerTab;
type EmailView = 'list' | 'detail' | 'compose';
type TabActivityDismissState = Record<CustomerTab, boolean>;
type ColorOpt = { label: string; hex: string };
type SmsThreadCache = Record<string, SmsMessage[]>;
type AddressSuggestion = {
  id: string;
  display: string;
};
type FitmentLookupResponse = {
  ok?: boolean;
  fitment?: {
    boltPattern?: string | null;
    rearBoltPattern?: string | null;
    pcd?: string | number | null;
    rearPcd?: string | number | null;
    centreBore?: string | null;
    wheelFasteners?: string | null;
    wheelTorque?: string | null;
    frontTireSize?: string | null;
    rearTireSize?: string | null;
    frontRimSize?: string | null;
    rearRimSize?: string | null;
  } | null;
  matched?: {
    trim?: string | null;
  } | null;
};
type ScheduleSettings = {
  bays?: Array<{ id: string; name: string }>;
  openHour?: number;
  closeHour?: number;
  showWeekends?: boolean;
  holidays?: string[];
  federalYear?: number;
  federalInitialized?: boolean;
};
type ScheduleDraft = {
  localId: string;
  id: string | null;
  startInput: string;
  endInput: string;
  resource: string;
  notes: string;
};

@Component({
  selector: 'app-customer-profile',
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
    IonSelect,
    IonSelectOption,
    IonTextarea,
    IonSpinner,
    IonBadge,
    UserMenuComponent,
    PageBackButtonComponent,
    CompanySwitcherComponent
  ],
  templateUrl: './customer-profile.component.html',
  styleUrls: ['./customer-profile.component.scss']
})
export default class CustomerProfileComponent implements OnInit, OnDestroy {
  @ViewChild('smsThreadContainer') private smsThreadContainer?: ElementRef<HTMLDivElement>;

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly customersApi = inject(CustomersApi);
  private readonly smsApi = inject(SmsApiService);
  private readonly emailApi = inject(EmailApiService);
  private readonly scheduleApi = inject(ScheduleApi);
  private readonly appSettingsApi = inject(AppSettingsApiService);
  private readonly invoicesData = inject(InvoicesDataService);

  private routeSub: Subscription | null = null;
  private querySub: Subscription | null = null;
  private addressLookupSub: Subscription | null = null;
  private unreadActivityTimer: ReturnType<typeof setInterval> | null = null;
  private addressSearchTimer: ReturnType<typeof setTimeout> | null = null;
  private initialCustomerSnapshot = '';
  private smsThreadCache: SmsThreadCache = {};

  readonly customerId = signal<string | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly status = signal('');
  readonly error = signal('');
  readonly activeTab = signal<CustomerTab>('notes');
  readonly isMobileLayout = signal(false);
  readonly mobileTab = signal<CustomerMobileTab>('profile');

  firstName = '';
  lastName = '';
  phone = '';
  email = '';
  address = '';
  notes = '';
  customerCreatedAt = '';

  vin = '';
  vinStatus = '';
  vinDecoded = signal<Record<string, string>>({});
  vehicleMake = '';
  vehicleModel = '';
  vehicleYear = '';
  vehicleTrim = '';
  vehicleDoors = '';
  bedLength = '';
  cabType = '';
  engineModel = '';
  engineCylinders = '';
  transmissionStyle = '';
  boltPattern = '';
  rearBoltPattern = '';
  pcd = '';
  rearPcd = '';
  centreBore = '';
  wheelFasteners = '';
  wheelTorque = '';
  frontTireSize = '';
  rearTireSize = '';
  frontRimSize = '';
  rearRimSize = '';
  vehicleColor = '';

  readonly smsThread = signal<SmsMessage[]>([]);
  readonly smsLoading = signal(false);
  readonly smsSending = signal(false);
  readonly smsStatus = signal('');
  readonly smsError = signal('');
  readonly scheduleEntries = signal<ScheduleDraft[]>([]);
  readonly scheduleLoading = signal(false);
  readonly scheduleSavingId = signal<string | null>(null);
  readonly scheduleDeletingId = signal<string | null>(null);
  readonly scheduleStatus = signal('');
  readonly scheduleError = signal('');
  readonly scheduleBays = signal<Array<{ id: string; name: string }>>([]);
  readonly unreadActivityCount = signal(0);
  readonly emailThread = signal<EmailMessage[]>([]);
  readonly emailLoading = signal(false);
  readonly emailSending = signal(false);
  readonly emailStatus = signal('');
  readonly emailError = signal('');
  readonly unreadEmailActivityCount = signal(0);
  readonly emailTemplates = signal<EmailTemplate[]>([]);
  readonly emailSignature = signal('');
  readonly emailView = signal<EmailView>('list');
  readonly selectedEmailId = signal<string | null>(null);
  readonly dismissedTabActivity = signal<TabActivityDismissState>({
    notes: false,
    schedule: false,
    invoices: false,
    sms: false,
    email: false
  });
  readonly addressSuggestions = signal<AddressSuggestion[]>([]);
  readonly addressSearching = signal(false);
  readonly addressValidated = signal(false);
  readonly addressNoMatches = signal(false);
  outgoingMessage = '';
  emailTo = '';
  emailSubject = '';
  emailMessage = '';
  selectedTemplateId = '';

  displayName(): string {
    const value = `${this.firstName} ${this.lastName}`.trim();
    return value || 'New Customer';
  }

  avatarInitials(): string {
    const parts = this.displayName()
      .split(/\s+/)
      .filter(Boolean);
    if (!parts.length) return 'NC';
    const first = parts[0].charAt(0);
    const second = parts.length > 1 ? parts[1].charAt(0) : parts[0].charAt(1);
    return `${first}${second || ''}`.toUpperCase();
  }

  avatarColor(): string {
    return this.colorForSeed(this.customerId() || this.displayName());
  }

  customerSinceLabel(): string {
    const raw = (this.customerCreatedAt || '').trim();
    if (!raw) return '';
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return raw;
    return new Date(parsed).toLocaleString();
  }

  readonly canUseSms = computed(() => !!this.customerId());
  readonly canUseEmail = computed(() => !!this.customerId());
  readonly hasVinDetails = computed(() => Object.values(this.vinDecoded()).some(value => !!value));
  readonly hasUnreadActivity = computed(() => this.unreadActivityCount() > 0);
  readonly selectedEmail = computed(() =>
    this.emailThread().find(item => item.id === this.selectedEmailId()) || null
  );

  readonly tabs: Array<{ key: CustomerTab; label: string; icon: string }> = [
    { key: 'notes', label: 'Notes', icon: 'document-text-outline' },
    { key: 'schedule', label: 'Scheduled', icon: 'calendar-outline' },
    { key: 'invoices', label: 'Invoices', icon: 'cash-outline' },
    { key: 'sms', label: 'SMS History', icon: 'chatbubble-ellipses-outline' },
    { key: 'email', label: 'Email History', icon: 'mail-outline' }
  ];
  readonly mobileTabs: Array<{ key: CustomerMobileTab; label: string; icon: string }> = [
    { key: 'profile', label: 'Profile', icon: 'person-outline' },
    { key: 'notes', label: 'Notes', icon: 'document-text-outline' },
    { key: 'schedule', label: 'Scheduled', icon: 'calendar-outline' },
    { key: 'invoices', label: 'Invoices', icon: 'cash-outline' },
    { key: 'sms', label: 'SMS', icon: 'chatbubble-ellipses-outline' },
    { key: 'email', label: 'Email', icon: 'mail-outline' }
  ];

  customerInvoices(): InvoiceCard[] {
    const fullName = `${this.firstName} ${this.lastName}`.trim();
    return this.invoicesData.forCustomer({
      id: this.customerId(),
      email: this.email,
      name: fullName || null
    });
  }

  invoiceAttentionCount(): number {
    return this.customerInvoices().filter(invoice => invoice.stage === 'draft' || invoice.stage === 'sent').length;
  }

  readonly palette: ColorOpt[] = [
    { label: 'White', hex: '#ffffff' },
    { label: 'Black', hex: '#000000' },
    { label: 'Silver', hex: '#c0c0c0' },
    { label: 'Gray', hex: '#808080' },
    { label: 'Red', hex: '#d32f2f' },
    { label: 'Blue', hex: '#1976d2' },
    { label: 'Green', hex: '#388e3c' },
    { label: 'Yellow', hex: '#fbc02d' },
    { label: 'Orange', hex: '#f57c00' },
    { label: 'Brown', hex: '#795548' }
  ];

  constructor() {
    addIcons({
      'person-outline': personOutline,
      'car-outline': carOutline,
      'calendar-outline': calendarOutline,
      'document-text-outline': documentTextOutline,
      'chatbubble-ellipses-outline': chatbubbleEllipsesOutline,
      'mail-outline': mailOutline,
      'add-outline': addOutline,
      'paper-plane-outline': paperPlaneOutline,
      'arrow-back-outline': arrowBackOutline,
      'save-outline': saveOutline,
      'cash-outline': cashOutline,
      'trash-outline': trashOutline
    });
  }

  ngOnInit(): void {
    this.updateMobileLayoutState();
    this.loadScheduleSettings();

    this.routeSub = this.route.paramMap.subscribe(params => {
      const id = params.get('id');
      const snapshotTab = (this.route.snapshot.queryParamMap.get('tab') || '').toLowerCase();
      const requestedTab = this.normalizeTab(snapshotTab);
      this.resetTabActivityDismissals(requestedTab || this.activeTab());
      if (id) {
        this.customerId.set(id);
        this.loadCustomer(id);
        this.refreshUnreadActivity();
      } else {
        this.customerId.set(null);
        this.resetForm();
        this.scheduleEntries.set([]);
        this.scheduleStatus.set('');
        this.scheduleError.set('');
        this.smsThread.set([]);
        this.unreadActivityCount.set(0);
        this.emailThread.set([]);
        this.unreadEmailActivityCount.set(0);
      }
    });

    this.querySub = this.route.queryParamMap.subscribe(query => {
      const tab = (query.get('tab') || '').toLowerCase();
      const normalized = this.normalizeTab(tab);
      if (normalized) {
        this.selectTab(normalized);
      }
    });

    this.refreshUnreadActivity();
    this.unreadActivityTimer = setInterval(() => this.refreshUnreadActivity(), 5000);
  }

  ngOnDestroy(): void {
    this.routeSub?.unsubscribe();
    this.querySub?.unsubscribe();
    this.addressLookupSub?.unsubscribe();
    if (this.addressSearchTimer) {
      clearTimeout(this.addressSearchTimer);
      this.addressSearchTimer = null;
    }
    if (this.unreadActivityTimer) {
      clearInterval(this.unreadActivityTimer);
      this.unreadActivityTimer = null;
    }
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.canDiscardChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  }

  @HostListener('window:resize')
  onWindowResize(): void {
    this.updateMobileLayoutState();
  }

  selectTab(tab: CustomerTab): void {
    this.activeTab.set(tab);
    if (this.isMobileLayout()) {
      this.mobileTab.set(tab);
    }
    this.setTabActivityDismissed(tab, true);
    if (tab === 'schedule' && this.customerId()) {
      this.loadCustomerSchedule();
      return;
    }
    if (tab === 'sms' && this.customerId()) {
      this.loadSmsThread();
      return;
    }
    if (tab === 'email' && this.customerId()) {
      this.loadEmailThread();
      this.loadEmailTemplates();
    }
  }

  selectMobileTab(tab: CustomerMobileTab): void {
    if (!this.isMobileLayout()) {
      if (tab !== 'profile') this.selectTab(tab);
      return;
    }
    this.mobileTab.set(tab);
    if (tab === 'profile') return;
    this.selectTab(tab);
  }

  canDeactivate(): boolean {
    if (this.canDiscardChanges()) return true;
    return window.confirm('You have unsaved changes. Leave without saving?');
  }

  async saveCustomer(): Promise<void> {
    this.status.set('');
    this.error.set('');
    const first = this.firstName.trim();
    const last = this.lastName.trim();
    const phone = this.phone.trim();
    const email = this.email.trim();
    const year = this.vehicleYear.trim();

    if (!this.hasCustomerChanges()) {
      this.status.set('No changes to save.');
      return;
    }

    if (!first || !last) {
      this.error.set('First and last name are required.');
      return;
    }

    if (!this.isPhoneValid()) {
      this.error.set('Enter a valid phone number.');
      return;
    }

    if (!this.isEmailValid()) {
      this.error.set('A valid email address is required.');
      return;
    }

    if (!this.isVehicleYearValid()) {
      this.error.set('Vehicle year must be a 4-digit value.');
      return;
    }

    if (!this.isAddressValid()) {
      this.error.set('Select a valid address from the suggestions, or clear it.');
      return;
    }

    const payload: Omit<Customer, 'id'> & { id?: string } = {
      id: this.customerId() || undefined,
      name: `${first} ${last}`.trim(),
      firstName: first,
      lastName: last,
      phone,
      email,
      address: this.address.trim(),
      vin: this.vin.trim(),
      vehicleMake: this.vehicleMake.trim(),
      vehicleModel: this.vehicleModel.trim(),
      vehicleYear: year,
      vehicleTrim: this.vehicleTrim.trim(),
      vehicleDoors: this.vehicleDoors.trim(),
      bedLength: this.bedLength.trim(),
      cabType: this.cabType.trim(),
      engineModel: this.engineModel.trim(),
      engineCylinders: this.engineCylinders.trim(),
      transmissionStyle: this.transmissionStyle.trim(),
      boltPattern: this.boltPattern.trim(),
      rearBoltPattern: this.rearBoltPattern.trim(),
      pcd: this.pcd.trim(),
      rearPcd: this.rearPcd.trim(),
      centreBore: this.centreBore.trim(),
      wheelFasteners: this.wheelFasteners.trim(),
      wheelTorque: this.wheelTorque.trim(),
      frontTireSize: this.frontTireSize.trim(),
      rearTireSize: this.rearTireSize.trim(),
      frontRimSize: this.frontRimSize.trim(),
      rearRimSize: this.rearRimSize.trim(),
      vehicleColor: this.vehicleColor.trim(),
      notes: this.notes.trim()
    };

    if (!payload.id) {
      payload.createdAt = new Date().toISOString();
    }

    try {
      const currentId = this.customerId();

      if (!currentId) {
        const duplicate = await this.findTopDuplicate(payload);
        if (duplicate) {
          const shouldMerge = window.confirm(
            `This customer appears similar to "${duplicate.name || 'existing customer'}" (${this.duplicateReasonsLabel(duplicate.reasons)}). Merge into the existing customer?`
          );
          if (shouldMerge) {
            this.saving.set(true);
            const merged = await firstValueFrom(this.customersApi.mergeDraftInto(duplicate.id, payload));
            const mergedId = merged.id || duplicate.id;
            this.status.set('Customer merged into existing record.');
            this.error.set('');
            this.customerId.set(mergedId);
            await this.router.navigate(['/customers', mergedId], {
              replaceUrl: true,
              queryParams: { tab: this.activeTab() }
            });
            this.captureInitialSnapshot();
            return;
          }

          const continueAsNew = window.confirm('Create as a separate customer anyway?');
          if (!continueAsNew) {
            this.status.set('Save cancelled.');
            return;
          }
        }
      } else {
        const duplicate = await this.findTopDuplicate(payload, currentId);
        if (duplicate) {
          const shouldMergeExisting = window.confirm(
            `This customer appears similar to "${duplicate.name || 'another customer'}" (${this.duplicateReasonsLabel(duplicate.reasons)}). Merge this current customer into that record?`
          );
          if (shouldMergeExisting) {
            this.saving.set(true);
            const merged = await firstValueFrom(this.customersApi.mergeCustomers(duplicate.id, currentId));
            const mergedId = merged.id || duplicate.id;
            this.status.set('Customers merged.');
            this.error.set('');
            this.customerId.set(mergedId);
            await this.router.navigate(['/customers', mergedId], {
              replaceUrl: true,
              queryParams: { tab: this.activeTab() }
            });
            this.captureInitialSnapshot();
            return;
          }
        }
      }

      this.saving.set(true);
      const res = await firstValueFrom(this.customersApi.upsert(payload));
      this.status.set('Customer saved.');
      this.error.set('');
      const savedId = res.id;
      if (!this.customerId()) {
        this.customerId.set(savedId);
        await this.router.navigate(['/customers', savedId], {
          replaceUrl: true,
          queryParams: { tab: this.activeTab() }
        });
        this.captureInitialSnapshot();
        return;
      }
      this.captureInitialSnapshot();
    } catch (err) {
      this.error.set(this.extractError(err, 'Could not save customer.'));
    } finally {
      this.saving.set(false);
    }
  }

  goBack(): void {
    this.router.navigate(['/customers']);
  }

  openCreateInvoice(): void {
    const customerId = (this.customerId() || '').trim();
    if (!customerId) {
      this.error.set('Save this customer first, then create an invoice.');
      return;
    }

    const vehicle = [this.vehicleYear, this.vehicleMake, this.vehicleModel]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .join(' ');

    this.status.set('');
    this.error.set('');
    this.router.navigate(['/invoices/new'], {
      queryParams: {
        customerId,
        customerName: this.displayName() || null,
        customerEmail: this.email.trim() || null,
        customerPhone: this.phone.trim() || null,
        customerVehicle: vehicle || null
      }
    });
  }

  openInvoice(invoice: InvoiceCard): void {
    const invoiceId = String(invoice?.id || '').trim();
    if (!invoiceId) return;
    this.status.set('');
    this.error.set('');
    void this.router.navigate(['/invoices', invoiceId]);
  }

  hasVehicleData(): boolean {
    return [
      this.vin,
      this.vehicleMake,
      this.vehicleModel,
      this.vehicleYear,
      this.vehicleTrim,
      this.vehicleDoors,
      this.bedLength,
      this.cabType,
      this.engineModel,
      this.engineCylinders,
      this.transmissionStyle,
      this.boltPattern,
      this.rearBoltPattern,
      this.pcd,
      this.rearPcd,
      this.centreBore,
      this.wheelFasteners,
      this.wheelTorque,
      this.frontTireSize,
      this.rearTireSize,
      this.frontRimSize,
      this.rearRimSize,
      this.vehicleColor
    ].some(value => !!String(value || '').trim()) || this.hasVinDetails();
  }

  confirmRemoveVehicle(): void {
    if (!this.hasVehicleData()) return;
    const confirmed = window.confirm(
      'Remove this vehicle from the customer profile? This clears VIN, decoded data, and wheel/tire fitment.'
    );
    if (!confirmed) return;
    this.clearVehicleData();
    this.status.set('Vehicle removed. Click Save Customer to keep this change.');
    this.error.set('');
  }

  lookupVIN(options?: {
    silent?: boolean;
    hydrateVehicleFields?: boolean;
    hydrateFitmentFields?: boolean;
    onSettled?: () => void;
  }): void {
    const silent = !!options?.silent;
    const hydrateVehicleFields = options?.hydrateVehicleFields !== false;
    const hydrateFitmentFields = options?.hydrateFitmentFields ?? !silent;
    const onSettled = options?.onSettled;
    const settle = () => onSettled?.();
    const vin = this.vin.trim().toUpperCase();
    this.vin = vin;
    if (!vin) {
      this.vinStatus = '';
      this.vinDecoded.set({});
      if (!silent) {
        this.clearFitmentFields();
      }
      settle();
      return;
    }
    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
      this.vinStatus = silent ? '' : 'VIN must be 17 characters and cannot include I, O, or Q.';
      this.vinDecoded.set({});
      if (!silent) {
        this.clearFitmentFields();
      }
      settle();
      return;
    }

    this.vinStatus = silent ? '' : 'Decoding VIN...';
    if (!silent) {
      this.clearFitmentFields();
    }
    const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`;
    this.http.get<any>(url).subscribe({
      next: res => {
        const result = res?.Results?.[0] || {};
        const make = this.cleanVinValue(result.Make);
        const model = this.cleanVinValue(result.Model);
        const modelYear = this.cleanVinValue(result.ModelYear);
        const trim = this.cleanVinValue(result.Trim);
        const doors = this.cleanVinValue(result.Doors);
        const bedLength = this.cleanVinValue(result.BedLength);
        const cabType = this.cleanVinValue(result.CabType);
        const engineModel = this.cleanVinValue(result.EngineModel);
        const engineCylinders = this.cleanVinValue(result.EngineCylinders);
        const transmissionStyle = this.cleanVinValue(result.TransmissionStyle);
        const tireSizeFront = this.cleanVinValue(result.TireSizeFront);
        const tireSizeRear = this.cleanVinValue(result.TireSizeRear);
        const wheelSizeFront = this.cleanVinValue(result.WheelSizeFront);
        const wheelSizeRear = this.cleanVinValue(result.WheelSizeRear);

        const plant = [result.PlantCity, result.PlantState, result.PlantCountry]
          .map(value => this.cleanVinValue(value))
          .filter(Boolean)
          .join(', ');

        const details: Record<string, string> = {};
        const add = (label: string, value: unknown) => {
          const clean = this.cleanVinValue(value);
          if (clean) details[label] = clean;
        };

        add('VIN', vin);
        add('Make', make);
        add('Model', model);
        add('Year', modelYear);
        add('Trim', trim);
        add('Series', result.Series);
        add('Vehicle type', result.VehicleType);
        add('Body class', result.BodyClass);
        add('Drive type', result.DriveType);
        const frontTireRim = tireSizeFront || (wheelSizeFront ? `${wheelSizeFront}" wheel` : '');
        const rearTireRim = tireSizeRear || (wheelSizeRear ? `${wheelSizeRear}" wheel` : '');
        if (frontTireRim && rearTireRim && frontTireRim === rearTireRim) {
          add('Tire / rim size', frontTireRim);
        } else {
          add('Tire / rim size (front)', frontTireRim);
          add('Tire / rim size (rear)', rearTireRim);
        }
        add('Wheel count', result.Wheels);
        add('Doors', doors);
        add('GVWR class', result.GVWR);
        add('Fuel type', result.FuelTypePrimary);
        add('Fuel type (secondary)', result.FuelTypeSecondary);
        add('Engine model', engineModel);
        add('Engine configuration', result.EngineConfiguration);
        add('Engine cylinders', engineCylinders);
        add('Engine horsepower', result.EngineHP);
        add('Engine displacement (L)', result.DisplacementL);
        add('Transmission', transmissionStyle);
        add('Transmission speeds', result.TransmissionSpeeds);
        add('Brake system', result.BrakeSystemType);
        add('Bed length', bedLength);
        add('Cab type', cabType);
        add('Manufacturer', result.Manufacturer);
        add('Plant', plant);
        this.applyStoredFitmentToDetails(details);

        this.vinDecoded.set(details);
        if (hydrateVehicleFields) {
          if (make) this.vehicleMake = make;
          if (model) this.vehicleModel = model;
          if (modelYear) this.vehicleYear = modelYear;
          if (trim) this.vehicleTrim = trim;
          if (doors) this.vehicleDoors = doors;
          if (bedLength) this.bedLength = bedLength;
          if (cabType) this.cabType = cabType;
          if (engineModel) this.engineModel = engineModel;
          if (engineCylinders) this.engineCylinders = engineCylinders;
          if (transmissionStyle) this.transmissionStyle = transmissionStyle;
        }

        if (!make || !model || !modelYear) {
          this.vinStatus = silent ? '' : 'VIN decoded successfully.';
          settle();
          return;
        }

        this.vinStatus = silent ? '' : 'VIN decoded. Looking up wheel/tire fitment...';
        this.lookupWheelFitment({
          make,
          model,
          year: modelYear,
          trim,
          details,
          silent,
          applyToForm: hydrateFitmentFields,
          onSettled: settle
        });
      },
      error: () => {
        this.vinDecoded.set({});
        if (!silent) {
          this.clearFitmentFields();
        }
        this.vinStatus = silent ? '' : 'VIN lookup failed.';
        settle();
      }
    });
  }

  loadSmsThread(): void {
    const customerId = this.customerId();
    if (!customerId) return;
    this.smsLoading.set(true);
    this.smsError.set('');
    this.smsApi
      .listCustomerMessages(customerId)
      .pipe(finalize(() => this.smsLoading.set(false)))
      .subscribe({
        next: res => {
          const serverItems = Array.isArray(res.items) ? res.items : [];
          const merged = this.mergeSmsMessages(serverItems, this.readSmsCache(customerId));
          this.smsThread.set(merged);
          this.writeSmsCache(customerId, merged);
          this.scrollSmsToBottom();
          this.markInboundMessagesRead(serverItems);
        },
        error: err => {
          const cached = this.readSmsCache(customerId);
          if (cached.length) {
            this.smsThread.set(cached);
            this.smsError.set('Live SMS history is unavailable. Showing cached messages.');
            this.scrollSmsToBottom();
            return;
          }
          this.smsError.set(this.extractError(err, 'Could not load SMS history.'));
        }
      });
  }

  sendSmsToCustomer(): void {
    const customerId = this.customerId();
    if (!customerId) {
      this.smsError.set('Save the customer first, then send SMS.');
      return;
    }

    const message = this.outgoingMessage.trim();
    if (!message) {
      this.smsError.set('SMS message cannot be empty.');
      return;
    }

    const to = this.normalizeE164(this.phone);
    if (!to) {
      this.smsError.set('Customer phone must be a valid US or E.164 number.');
      return;
    }

    this.smsSending.set(true);
    this.smsError.set('');
    this.smsStatus.set('');
    this.smsApi
      .sendToCustomer({
        customerId,
        customerName: this.displayName(),
        to,
        message
      })
      .pipe(finalize(() => this.smsSending.set(false)))
      .subscribe({
        next: res => {
          this.appendLocalSmsMessage({
            id: res.id || this.localMessageId('outbound'),
            customerId,
            customerName: this.displayName(),
            direction: 'outbound',
            from: null,
            to,
            message,
            createdAt: res.createdAt || new Date().toISOString(),
            read: true,
            readAt: new Date().toISOString(),
            simulated: !!res.simulated,
            provider: res.provider || null,
            providerMessageId: res.messageId || null,
            deliveryStatus: res.deliveryStatus || (res.simulated ? 'delivered' : 'queued'),
            deliveryStatusRaw: null,
            deliveryUpdatedAt: res.createdAt || new Date().toISOString(),
            deliveredAt: res.simulated ? (res.createdAt || new Date().toISOString()) : null,
            failedAt: null,
            providerErrorCode: null,
            providerErrorMessage: null
          });
          this.outgoingMessage = '';
          this.smsStatus.set(
            res.simulated
              ? 'Mock SMS logged. No carrier send attempted.'
              : 'SMS sent and saved to history.'
          );
          this.loadSmsThread();
        },
        error: err => {
          this.smsError.set(this.extractError(err, 'SMS send failed.'));
        }
      });
  }

  logIncomingMessage(): void {
    const customerId = this.customerId();
    if (!customerId) {
      this.smsError.set('Save the customer first, then add inbound messages.');
      return;
    }

    const message = this.outgoingMessage.trim();
    if (!message) {
      this.smsError.set('Incoming message cannot be empty.');
      return;
    }

    this.smsSending.set(true);
    this.smsError.set('');
    this.smsStatus.set('');
    this.smsApi
      .logIncoming({
        customerId,
        customerName: this.displayName(),
        from: this.normalizeE164(this.phone) || undefined,
        message
      })
      .pipe(finalize(() => this.smsSending.set(false)))
      .subscribe({
        next: res => {
          this.appendLocalSmsMessage({
            id: res.id || this.localMessageId('inbound'),
            customerId,
            customerName: this.displayName(),
            direction: 'inbound',
            from: this.normalizeE164(this.phone) || null,
            to: null,
            message,
            createdAt: res.createdAt || new Date().toISOString(),
            read: false,
            readAt: null,
            simulated: true,
            provider: 'manual',
            providerMessageId: null,
            deliveryStatus: 'received',
            deliveryStatusRaw: 'manual',
            deliveryUpdatedAt: res.createdAt || new Date().toISOString(),
            deliveredAt: null,
            failedAt: null,
            providerErrorCode: null,
            providerErrorMessage: null
          });
          this.outgoingMessage = '';
          this.smsStatus.set('Inbound message added to customer history.');
          this.loadSmsThread();
        },
        error: err => {
          const detail = this.extractError(err, 'Could not add inbound message.');
          if (detail.includes('`to` and `message` are required')) {
            this.smsError.set('Inbound simulation requires the latest /api/sms API. You are likely connected to an older API version. Run `npm start` for local API + UI, or redeploy your Azure Functions.');
            return;
          }
          this.smsError.set(detail);
        }
      });
  }

  loadCustomerSchedule(): void {
    const customerId = (this.customerId() || '').trim();
    if (!customerId) {
      this.scheduleEntries.set([]);
      return;
    }

    this.scheduleLoading.set(true);
    this.scheduleStatus.set('');
    this.scheduleError.set('');
    this.scheduleApi
      .list()
      .pipe(finalize(() => this.scheduleLoading.set(false)))
      .subscribe({
        next: items => {
          const rows = (Array.isArray(items) ? items : [])
            .filter(item => !item.isBlocked && String(item.customerId || '').trim() === customerId)
            .sort((a, b) => Date.parse(a.start || '') - Date.parse(b.start || ''))
            .map(item => this.mapScheduleItemToDraft(item));
          this.scheduleEntries.set(rows);
        },
        error: err => {
          this.scheduleError.set(this.extractError(err, 'Could not load schedule.'));
        }
      });
  }

  openScheduleAppointmentModal(): void {
    const customerId = (this.customerId() || '').trim();
    if (!customerId) {
      this.scheduleError.set('Save the customer first, then add an appointment.');
      return;
    }
    this.scheduleStatus.set('');
    this.scheduleError.set('');
    this.router.navigate(['/schedule'], {
      queryParams: { customerId }
    });
  }

  upcomingScheduleEntries(): ScheduleDraft[] {
    const now = Date.now();
    return [...this.scheduleEntries()]
      .filter(entry => {
        const end = this.scheduleEndValue(entry);
        return !Number.isFinite(end) || end >= now;
      })
      .sort((a, b) => {
        const aStart = this.scheduleStartValue(a);
        const bStart = this.scheduleStartValue(b);
        const aComparable = Number.isFinite(aStart) ? aStart : Number.MAX_SAFE_INTEGER;
        const bComparable = Number.isFinite(bStart) ? bStart : Number.MAX_SAFE_INTEGER;
        return aComparable - bComparable;
      });
  }

  historyScheduleEntries(): ScheduleDraft[] {
    const now = Date.now();
    return [...this.scheduleEntries()]
      .filter(entry => {
        const end = this.scheduleEndValue(entry);
        return Number.isFinite(end) && end < now;
      })
      .sort((a, b) => {
        const aEnd = this.scheduleEndValue(a);
        const bEnd = this.scheduleEndValue(b);
        const aComparable = Number.isFinite(aEnd) ? aEnd : 0;
        const bComparable = Number.isFinite(bEnd) ? bEnd : 0;
        return bComparable - aComparable;
      });
  }

  scheduleDateLabel(value: string): string {
    const normalized = toLocalDateTimeStorage(value);
    const parsed = Date.parse(normalized || value || '');
    if (!Number.isFinite(parsed)) return value;
    return new Date(parsed).toLocaleString();
  }

  scheduleBayLabel(resource: string): string {
    const value = String(resource || '').trim();
    if (!value) return 'Unassigned';
    const bay = this.scheduleBays().find(item => item.id === value);
    return bay?.name || value;
  }

  saveScheduleDraft(draft: ScheduleDraft): void {
    const customerId = (this.customerId() || '').trim();
    if (!customerId) {
      this.scheduleError.set('Save the customer first, then update schedule.');
      return;
    }

    const start = toLocalDateTimeStorage(draft.startInput);
    const end = toLocalDateTimeStorage(draft.endInput);
    const resource = String(draft.resource || '').trim() || this.defaultScheduleResource();
    const notes = String(draft.notes || '').trim();

    if (!start || !end || !resource) {
      this.scheduleError.set('Start, end, and bay are required.');
      return;
    }
    if (Date.parse(start) >= Date.parse(end)) {
      this.scheduleError.set('End must be after start.');
      return;
    }

    this.scheduleSavingId.set(draft.localId);
    this.scheduleStatus.set('');
    this.scheduleError.set('');

    const complete = () => this.scheduleSavingId.set(null);
    if (draft.id) {
      this.scheduleApi
        .update({
          id: draft.id,
          customerId,
          start,
          end,
          resource,
          notes,
          isBlocked: false
        })
        .pipe(finalize(complete))
        .subscribe({
          next: () => {
            this.scheduleStatus.set('Schedule updated.');
            this.loadCustomerSchedule();
          },
          error: err => this.scheduleError.set(this.extractError(err, 'Could not update schedule.'))
        });
      return;
    }

    this.scheduleApi
      .create({
        customerId,
        start,
        end,
        resource,
        notes,
        isBlocked: false
      })
      .pipe(finalize(complete))
      .subscribe({
        next: () => {
          this.scheduleStatus.set('Schedule saved.');
          this.loadCustomerSchedule();
        },
        error: err => this.scheduleError.set(this.extractError(err, 'Could not save schedule.'))
      });
  }

  removeScheduleDraft(draft: ScheduleDraft): void {
    if (!draft.id) {
      this.scheduleEntries.update(list => list.filter(item => item.localId !== draft.localId));
      this.scheduleStatus.set('Draft removed.');
      this.scheduleError.set('');
      return;
    }

    if (!window.confirm('Remove this scheduled appointment?')) return;
    this.scheduleDeletingId.set(draft.localId);
    this.scheduleStatus.set('');
    this.scheduleError.set('');
    this.scheduleApi
      .delete(draft.id)
      .pipe(finalize(() => this.scheduleDeletingId.set(null)))
      .subscribe({
        next: () => {
          this.scheduleStatus.set('Schedule removed.');
          this.loadCustomerSchedule();
        },
        error: err => this.scheduleError.set(this.extractError(err, 'Could not remove schedule.'))
      });
  }

  isScheduleDraftValid(draft: ScheduleDraft): boolean {
    const start = toLocalDateTimeStorage(draft.startInput);
    const end = toLocalDateTimeStorage(draft.endInput);
    const resource = String(draft.resource || '').trim();
    if (!start || !end || !resource) return false;
    return Date.parse(start) < Date.parse(end);
  }

  isKnownScheduleBay(resource: string): boolean {
    const value = String(resource || '').trim();
    if (!value) return false;
    return this.scheduleBays().some(bay => bay.id === value);
  }

  trackScheduleDraft(_index: number, draft: ScheduleDraft): string {
    return draft.localId;
  }

  loadEmailThread(): void {
    const customerId = this.customerId();
    if (!customerId) return;
    this.emailLoading.set(true);
    this.emailError.set('');
    this.emailApi
      .listCustomerMessages(customerId)
      .pipe(finalize(() => this.emailLoading.set(false)))
      .subscribe({
        next: res => {
          const items = Array.isArray(res.items) ? res.items : [];
          items.sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''));
          this.emailThread.set(items);
          if (!items.length) {
            this.selectedEmailId.set(null);
            this.emailView.set('list');
          }
          this.markInboundEmailsRead(items);
        },
        error: err => {
          this.emailError.set(this.extractError(err, 'Could not load email history.'));
        }
      });
  }

  loadEmailTemplates(): void {
    this.emailApi.listTemplates().subscribe({
      next: res => {
        this.emailTemplates.set(Array.isArray(res.templates) ? res.templates : []);
        this.emailSignature.set(typeof res.signature === 'string' ? res.signature : '');
      },
      error: err => {
        this.emailError.set(this.extractError(err, 'Could not load email templates.'));
      }
    });
  }

  startNewEmail(): void {
    if (!this.customerId()) {
      this.emailError.set('Save the customer first, then compose email.');
      return;
    }

    this.emailStatus.set('');
    this.emailError.set('');
    this.selectedTemplateId = '';
    this.selectedEmailId.set(null);
    this.emailView.set('compose');
    this.emailTo = this.email.trim();
    this.emailSubject = '';
    this.emailMessage = this.composeWithSignature('');
  }

  startReplyEmail(): void {
    if (!this.customerId()) {
      this.emailError.set('Save the customer first, then compose email.');
      return;
    }

    const current = this.selectedEmail();
    if (!current) {
      this.startNewEmail();
      return;
    }

    const recipientRaw = current.direction === 'inbound' ? current.from : current.to;
    const recipient = String(recipientRaw || '').trim();
    if (!this.isValidEmailAddress(recipient)) {
      this.emailError.set('Reply recipient email is missing or invalid.');
      return;
    }

    const subject = String(current.subject || '').trim();
    const nextSubject = subject
      ? (/^re:/i.test(subject) ? subject : `Re: ${subject}`)
      : 'Re:';
    const senderLabel = current.direction === 'inbound' ? (current.from || 'customer') : 'you';
    const originalBody = String(current.message || '').trim();
    const quotedBody = originalBody
      ? originalBody.split('\n').map(line => `> ${line}`).join('\n')
      : '> (no original body)';
    const quoteHeader = `On ${this.emailDateLabel(current.createdAt)}, ${senderLabel} wrote:`;
    const signature = this.composeWithSignature('');
    const sections = [signature, quoteHeader, quotedBody].filter(section => !!section.trim());

    this.emailStatus.set('');
    this.emailError.set('');
    this.selectedTemplateId = '';
    this.emailTo = recipient;
    this.emailSubject = nextSubject;
    this.emailMessage = sections.join('\n\n');
    this.emailView.set('compose');
  }

  backToEmailList(): void {
    this.emailView.set('list');
    this.selectedEmailId.set(null);
    this.emailStatus.set('');
    this.emailError.set('');
  }

  openEmailMessage(messageId: string): void {
    this.emailStatus.set('');
    this.emailError.set('');
    this.selectedEmailId.set(messageId);
    this.emailView.set('detail');

    const item = this.emailThread().find(entry => entry.id === messageId);
    if (!item || item.direction !== 'inbound' || item.read) return;
    this.emailApi.markRead(item.id).subscribe({
      next: () => {
        this.emailThread.update(list =>
          list.map(entry => entry.id === item.id
            ? { ...entry, read: true, readAt: new Date().toISOString() }
            : entry
          )
        );
        this.unreadEmailActivityCount.set(0);
      }
    });
  }

  applySelectedTemplate(templateId: string | null | undefined): void {
    this.selectedTemplateId = String(templateId || '');
    if (!this.selectedTemplateId) return;
    const template = this.emailTemplates().find(item => item.id === this.selectedTemplateId);
    if (!template) return;
    this.emailSubject = template.subject;
    this.emailMessage = this.composeWithSignature(template.body);
  }

  canSubmitEmail(): boolean {
    return !!this.customerId() &&
      this.isValidEmailAddress(this.emailTo) &&
      !!this.emailSubject.trim() &&
      !!this.emailMessage.trim();
  }

  sendEmailToCustomer(): void {
    const customerId = this.customerId();
    if (!customerId) {
      this.emailError.set('Save the customer first, then send email.');
      return;
    }

    const to = this.emailTo.trim();
    const subject = this.emailSubject.trim();
    const message = this.emailMessage.trim();

    if (!this.isValidEmailAddress(to)) {
      this.emailError.set('Enter a valid recipient email.');
      return;
    }
    if (!subject) {
      this.emailError.set('Email subject is required.');
      return;
    }
    if (!message) {
      this.emailError.set('Email message cannot be empty.');
      return;
    }

    this.emailSending.set(true);
    this.emailError.set('');
    this.emailStatus.set('');
    this.emailApi
      .sendToCustomer({
        customerId,
        customerName: this.displayName(),
        to,
        subject,
        message
      })
      .pipe(finalize(() => this.emailSending.set(false)))
      .subscribe({
        next: res => {
          const outbound: EmailMessage = {
            id: res.id,
            customerId,
            customerName: this.displayName(),
            direction: 'outbound',
            from: null,
            to,
            subject,
            message,
            html: null,
            createdAt: res.createdAt || new Date().toISOString(),
            read: true,
            readAt: new Date().toISOString(),
            simulated: !!res.simulated,
            provider: res.provider || null,
            providerMessageId: res.messageId || null
          };
          this.emailThread.update(list => {
            const next = [...list, outbound];
            next.sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''));
            return next;
          });
          this.selectedEmailId.set(outbound.id);
          this.emailView.set('detail');
          this.emailStatus.set(res.simulated
            ? 'Mock email logged. No provider send attempted.'
            : 'Email sent and saved to history.');
          this.loadEmailThread();
        },
        error: err => {
          this.emailError.set(this.extractError(err, 'Email send failed.'));
        }
      });
  }

  emailDateLabel(value: string): string {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return value;
    return new Date(parsed).toLocaleString();
  }

  emailPreviewText(message: EmailMessage): string {
    const source = (message.message || message.subject || '').replace(/\s+/g, ' ').trim();
    if (!source) return '(no preview)';
    return source.length > 120 ? `${source.slice(0, 117)}...` : source;
  }

  trackEmail(_index: number, message: EmailMessage): string {
    return message.id;
  }

  trackInvoice(_index: number, invoice: InvoiceCard): string {
    return invoice.id;
  }

  invoiceStatusLabel(invoice: InvoiceCard): string {
    return `${invoice.stage.charAt(0).toUpperCase()}${invoice.stage.slice(1)}`;
  }

  invoiceBadgeColor(invoice: InvoiceCard): string {
    if (invoice.stage === 'accepted') return 'success';
    if (invoice.stage === 'declined') return 'danger';
    if (invoice.stage === 'expired') return 'medium';
    if (invoice.stage === 'draft') return 'warning';
    if (invoice.stage === 'sent') return 'primary';
    return 'medium';
  }

  smsDateLabel(value: string): string {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return value;
    return new Date(parsed).toLocaleString();
  }

  smsDeliveryLabel(message: SmsMessage): string {
    const status = this.smsDeliveryStatus(message);
    if (status === 'delivered') return 'Delivered';
    if (status === 'failed') return 'Failed';
    if (status === 'received') return 'Received';
    return 'Queued';
  }

  smsDeliveryClass(message: SmsMessage): string {
    const status = this.smsDeliveryStatus(message);
    if (status === 'delivered') return 'delivered';
    if (status === 'failed') return 'failed';
    if (status === 'received') return 'received';
    return 'queued';
  }

  smsDeliveryTitle(message: SmsMessage): string {
    const parts = [
      this.smsDeliveryLabel(message),
      message.providerErrorMessage || '',
      message.providerErrorCode ? `code: ${message.providerErrorCode}` : ''
    ].filter(Boolean);
    return parts.join(' • ');
  }

  trackSms(_index: number, msg: SmsMessage): string {
    return msg.id;
  }

  isEmailValid(): boolean {
    const value = this.email.trim();
    return !!value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  isPhoneValid(): boolean {
    return !!this.normalizeE164(this.phone.trim());
  }

  isVehicleYearValid(): boolean {
    const year = this.vehicleYear.trim();
    if (!year) return true;
    return /^\d{4}$/.test(year);
  }

  hasCustomerChanges(): boolean {
    return this.buildCustomerSnapshot() !== this.initialCustomerSnapshot;
  }

  canSaveCustomer(): boolean {
    return this.hasCustomerChanges() && this.isEmailValid() && this.isPhoneValid() && this.isVehicleYearValid() &&
      this.isAddressValid() &&
      !!this.firstName.trim() && !!this.lastName.trim();
  }

  canSubmitSms(): boolean {
    return !!this.customerId() && !!this.outgoingMessage.trim();
  }

  tabHasActivity(tab: CustomerTab): boolean {
    return this.tabActivityCount(tab) > 0;
  }

  mobileTabActivityCount(tab: CustomerMobileTab): number {
    if (tab === 'profile') return 0;
    return this.tabActivityCount(tab);
  }

  tabActivityTitle(tab: CustomerTab): string {
    const count = this.tabActivityCount(tab);
    if (!count) return '';
    if (tab === 'sms') return `${count} unread SMS ${count === 1 ? 'message' : 'messages'}`;
    if (tab === 'email') return `${count} unread email ${count === 1 ? 'message' : 'messages'}`;
    if (tab === 'invoices') return `${count} invoice ${count === 1 ? 'item needs attention' : 'items need attention'}`;
    return '';
  }

  tabActivityCount(tab: CustomerTab): number {
    const count = this.rawTabActivityCount(tab);
    if (!count) return 0;
    if (this.dismissedTabActivity()[tab]) return 0;
    return count;
  }

  private rawTabActivityCount(tab: CustomerTab): number {
    if (tab === 'sms') return this.unreadActivityCount();
    if (tab === 'email') return this.unreadEmailActivityCount();
    if (tab === 'invoices') return this.invoiceAttentionCount();
    return 0;
  }

  activeTabLabel(): string {
    const current = this.tabs.find(tab => tab.key === this.activeTab());
    return current?.label || 'Details';
  }

  tabIcon(tab: CustomerTab): string {
    const current = this.tabs.find(item => item.key === tab);
    return current?.icon || 'document-text-outline';
  }

  onAddressChange(value: string | null | undefined): void {
    this.address = String(value || '');
    this.addressValidated.set(false);
    this.addressNoMatches.set(false);
    this.queueAddressLookup(this.address);
  }

  onAddressBlur(): void {
    const normalized = this.address.trim().toLowerCase();
    if (normalized && !this.addressValidated()) {
      const exact = this.addressSuggestions().find(item => item.display.trim().toLowerCase() === normalized);
      if (exact) {
        this.selectAddressSuggestion(exact);
      }
    }
    setTimeout(() => {
      this.addressSuggestions.set([]);
    }, 120);
  }

  selectAddressSuggestion(item: AddressSuggestion): void {
    this.address = item.display;
    this.addressValidated.set(true);
    this.addressSuggestions.set([]);
    this.addressNoMatches.set(false);
  }

  onSmsComposerKeydown(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (!keyboard || keyboard.key !== 'Enter') return;
    if (keyboard.shiftKey || keyboard.altKey || keyboard.ctrlKey || keyboard.metaKey) return;
    if ((keyboard as unknown as { isComposing?: boolean }).isComposing) return;
    keyboard.preventDefault();
    if (this.smsSending() || !this.canSubmitSms()) return;
    this.sendSmsToCustomer();
  }

  private loadCustomer(id: string): void {
    this.loading.set(true);
    this.status.set('');
    this.error.set('');
    this.customersApi
      .getById(id)
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: customer => {
          if (!customer) {
            this.error.set('Customer not found.');
            this.resetForm();
            return;
          }
          this.fillForm(customer);
          if (this.activeTab() === 'schedule') {
            this.loadCustomerSchedule();
            return;
          }
          if (this.activeTab() === 'sms') {
            this.loadSmsThread();
            return;
          }
          if (this.activeTab() === 'email') {
            this.loadEmailThread();
            this.loadEmailTemplates();
          }
        },
        error: err => {
          this.error.set(this.extractError(err, 'Could not load customer.'));
          this.resetForm();
        }
      });
  }

  private fillForm(customer: Customer): void {
    const fullName = (customer.name || '').trim();
    const parts = fullName.split(/\s+/).filter(Boolean);
    this.firstName = customer.firstName || (parts.slice(0, -1).join(' ') || parts[0] || '');
    this.lastName = customer.lastName || (parts.length > 1 ? parts[parts.length - 1] : '');
    this.phone = customer.phone || '';
    this.email = customer.email || '';
    this.emailTo = customer.email || '';
    this.emailSubject = '';
    this.emailMessage = '';
    this.selectedTemplateId = '';
    this.emailView.set('list');
    this.selectedEmailId.set(null);
    this.emailStatus.set('');
    this.emailError.set('');
    this.address = customer.address || '';
    this.notes = customer.notes || '';
    this.customerCreatedAt = customer.createdAt || '';
    this.vin = (customer.vin || '').toUpperCase();
    this.vehicleMake = customer.vehicleMake || '';
    this.vehicleModel = customer.vehicleModel || '';
    this.vehicleYear = customer.vehicleYear || '';
    this.vehicleTrim = customer.vehicleTrim || '';
    this.vehicleDoors = customer.vehicleDoors || '';
    this.bedLength = customer.bedLength || '';
    this.cabType = customer.cabType || '';
    this.engineModel = customer.engineModel || '';
    this.engineCylinders = customer.engineCylinders || '';
    this.transmissionStyle = customer.transmissionStyle || '';
    this.boltPattern = customer.boltPattern || '';
    this.rearBoltPattern = customer.rearBoltPattern || '';
    this.pcd = customer.pcd || '';
    this.rearPcd = customer.rearPcd || '';
    this.centreBore = customer.centreBore || '';
    this.wheelFasteners = customer.wheelFasteners || '';
    this.wheelTorque = customer.wheelTorque || '';
    this.frontTireSize = customer.frontTireSize || '';
    this.rearTireSize = customer.rearTireSize || '';
    this.frontRimSize = customer.frontRimSize || '';
    this.rearRimSize = customer.rearRimSize || '';
    this.vehicleColor = customer.vehicleColor || '';
    this.vinStatus = '';
    this.vinDecoded.set({});
    this.addressSuggestions.set([]);
    this.addressSearching.set(false);
    this.addressNoMatches.set(false);
    this.addressValidated.set(!!this.address.trim());
    this.captureInitialSnapshot();
    if (this.vin) {
      this.lookupVIN({
        silent: true,
        hydrateVehicleFields: false,
        hydrateFitmentFields: false,
        onSettled: () => this.captureInitialSnapshot()
      });
    }
  }

  private resetForm(): void {
    this.firstName = '';
    this.lastName = '';
    this.phone = '';
    this.email = '';
    this.emailTo = '';
    this.emailSubject = '';
    this.emailMessage = '';
    this.selectedTemplateId = '';
    this.emailView.set('list');
    this.selectedEmailId.set(null);
    this.address = '';
    this.notes = '';
    this.customerCreatedAt = '';
    this.vin = '';
    this.vinStatus = '';
    this.vinDecoded.set({});
    this.addressSuggestions.set([]);
    this.addressSearching.set(false);
    this.addressNoMatches.set(false);
    this.addressValidated.set(false);
    this.vehicleMake = '';
    this.vehicleModel = '';
    this.vehicleYear = '';
    this.vehicleTrim = '';
    this.vehicleDoors = '';
    this.bedLength = '';
    this.cabType = '';
    this.engineModel = '';
    this.engineCylinders = '';
    this.transmissionStyle = '';
    this.boltPattern = '';
    this.rearBoltPattern = '';
    this.pcd = '';
    this.rearPcd = '';
    this.centreBore = '';
    this.wheelFasteners = '';
    this.wheelTorque = '';
    this.frontTireSize = '';
    this.rearTireSize = '';
    this.frontRimSize = '';
    this.rearRimSize = '';
    this.vehicleColor = '';
    this.outgoingMessage = '';
    this.smsStatus.set('');
    this.smsError.set('');
    this.scheduleEntries.set([]);
    this.scheduleStatus.set('');
    this.scheduleError.set('');
    this.scheduleSavingId.set(null);
    this.scheduleDeletingId.set(null);
    this.emailThread.set([]);
    this.emailTemplates.set([]);
    this.emailSignature.set('');
    this.emailStatus.set('');
    this.emailError.set('');
    this.unreadEmailActivityCount.set(0);
    this.captureInitialSnapshot();
  }

  private markInboundMessagesRead(items: SmsMessage[]): void {
    const unreadIds = items
      .filter(item => item.direction === 'inbound' && !item.read)
      .map(item => item.id);
    if (!unreadIds.length) return;
    this.smsApi.markReadBatch(unreadIds).subscribe({
      next: () => this.unreadActivityCount.set(0)
    });
  }

  private smsDeliveryStatus(message: SmsMessage): SmsDeliveryStatus {
    const raw = (message.deliveryStatus || '').toString().toLowerCase();
    if (raw === 'delivered') return 'delivered';
    if (raw === 'failed') return 'failed';
    if (raw === 'received') return 'received';
    if (raw === 'queued') return 'queued';
    return message.direction === 'inbound' ? 'received' : 'queued';
  }

  private markInboundEmailsRead(items: EmailMessage[]): void {
    const unreadIds = items
      .filter(item => item.direction === 'inbound' && !item.read)
      .map(item => item.id);
    if (!unreadIds.length) {
      this.unreadEmailActivityCount.set(0);
      return;
    }
    this.emailApi.markReadBatch(unreadIds).subscribe({
      next: () => this.unreadEmailActivityCount.set(0)
    });
  }

  private appendLocalSmsMessage(message: SmsMessage): void {
    const customerId = this.customerId();
    if (!customerId) return;
    const merged = this.mergeSmsMessages([message], this.smsThread());
    this.smsThread.set(merged);
    this.writeSmsCache(customerId, merged);
    this.scrollSmsToBottom();
  }

  private mergeSmsMessages(primary: SmsMessage[], secondary: SmsMessage[]): SmsMessage[] {
    const byId = new Map<string, SmsMessage>();
    const mergedInput = [...secondary, ...primary];
    for (const item of mergedInput) {
      const key = item.id || `${item.direction}:${item.createdAt}:${item.message}`;
      byId.set(key, item);
    }
    return Array.from(byId.values()).sort((a, b) => {
      const ta = Date.parse(a.createdAt || '');
      const tb = Date.parse(b.createdAt || '');
      if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
      if (Number.isFinite(ta)) return -1;
      if (Number.isFinite(tb)) return 1;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
  }

  private readSmsCache(customerId: string): SmsMessage[] {
    if (!customerId) return [];
    const value = this.smsThreadCache[customerId];
    return Array.isArray(value) ? value : [];
  }

  private writeSmsCache(customerId: string, items: SmsMessage[]): void {
    if (!customerId) return;
    this.smsThreadCache = {
      ...this.smsThreadCache,
      [customerId]: items.slice(-250)
    };
  }

  private refreshUnreadActivity(): void {
    const customerId = (this.customerId() || '').trim();
    if (!customerId) {
      this.unreadActivityCount.set(0);
      this.unreadEmailActivityCount.set(0);
      this.setTabActivityDismissed('sms', false);
      this.setTabActivityDismissed('email', false);
      return;
    }

    this.smsApi.listInbox().subscribe({
      next: res => {
        const previous = this.unreadActivityCount();
        const items = Array.isArray(res.items) ? res.items : [];
        let count = 0;
        for (const item of items) {
          if ((item.customerId || '').trim() === customerId) count += 1;
        }
        this.unreadActivityCount.set(count);
        if (!count) {
          this.setTabActivityDismissed('sms', false);
          return;
        }
        if (count > previous && this.activeTab() !== 'sms') {
          this.setTabActivityDismissed('sms', false);
        }
      }
    });

    this.emailApi.listInbox().subscribe({
      next: res => {
        const previous = this.unreadEmailActivityCount();
        const items = Array.isArray(res.items) ? res.items : [];
        let count = 0;
        for (const item of items) {
          if ((item.customerId || '').trim() === customerId) count += 1;
        }
        this.unreadEmailActivityCount.set(count);
        if (!count) {
          this.setTabActivityDismissed('email', false);
          return;
        }
        if (count > previous && this.activeTab() !== 'email') {
          this.setTabActivityDismissed('email', false);
        }
      }
    });
  }

  private resetTabActivityDismissals(activeTab?: CustomerTab): void {
    const next: TabActivityDismissState = {
      notes: false,
      schedule: false,
      invoices: false,
      sms: false,
      email: false
    };
    if (activeTab) {
      next[activeTab] = true;
    }
    this.dismissedTabActivity.set(next);
  }

  private setTabActivityDismissed(tab: CustomerTab, dismissed: boolean): void {
    this.dismissedTabActivity.update(state => {
      if (state[tab] === dismissed) return state;
      return { ...state, [tab]: dismissed };
    });
  }

  private localMessageId(prefix: SmsMessage['direction']): string {
    return `local-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private localScheduleId(): string {
    return `local-schedule-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private scrollSmsToBottom(): void {
    if (typeof window === 'undefined') return;
    const jump = () => {
      const el = this.smsThreadContainer?.nativeElement;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
    };
    jump();
    requestAnimationFrame(jump);
    setTimeout(jump, 80);
  }

  private loadScheduleSettings(): void {
    this.appSettingsApi.getValue<ScheduleSettings>('schedule.settings').subscribe(value => {
      const bays = value && Array.isArray(value.bays)
        ? value.bays
        : [];
      if (!bays.length) {
        this.scheduleBays.set([{ id: 'bay-1', name: 'Two-Post Lift 1' }]);
        return;
      }
      this.scheduleBays.set(
        bays
          .map(item => ({
            id: String(item?.id || '').trim(),
            name: String(item?.name || item?.id || '').trim()
          }))
          .filter(item => !!item.id)
      );
      if (!this.scheduleBays().length) {
        this.scheduleBays.set([{ id: 'bay-1', name: 'Two-Post Lift 1' }]);
      }
    });
  }

  private defaultScheduleResource(): string {
    const first = this.scheduleBays()[0];
    return first?.id || 'bay-1';
  }

  private defaultScheduleWindow(): { start: string; end: string } {
    const base = new Date();
    base.setMinutes(0, 0, 0);
    if (base.getHours() < 7) {
      base.setHours(7, 0, 0, 0);
    } else if (base.getHours() >= 16) {
      base.setDate(base.getDate() + 1);
      base.setHours(7, 0, 0, 0);
    } else {
      base.setHours(base.getHours() + 1, 0, 0, 0);
    }
    const end = new Date(base.getTime() + 2 * 60 * 60 * 1000);
    return {
      start: toLocalDateTimeInput(formatLocalDateTime(base)),
      end: toLocalDateTimeInput(formatLocalDateTime(end))
    };
  }

  private mapScheduleItemToDraft(item: ScheduleItem): ScheduleDraft {
    const resource = String(item.resource || '').trim() || this.defaultScheduleResource();
    return {
      localId: item.id,
      id: item.id,
      startInput: toLocalDateTimeInput(item.start),
      endInput: toLocalDateTimeInput(item.end),
      resource,
      notes: String(item.notes || '')
    };
  }

  private scheduleStartValue(entry: ScheduleDraft): number {
    return this.scheduleTimeValue(entry.startInput);
  }

  private scheduleEndValue(entry: ScheduleDraft): number {
    return this.scheduleTimeValue(entry.endInput);
  }

  private scheduleTimeValue(value: string): number {
    const normalized = toLocalDateTimeStorage(value);
    const parsed = Date.parse(normalized || value || '');
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }

  private clearFitmentFields(): void {
    this.boltPattern = '';
    this.rearBoltPattern = '';
    this.pcd = '';
    this.rearPcd = '';
    this.centreBore = '';
    this.wheelFasteners = '';
    this.wheelTorque = '';
    this.frontTireSize = '';
    this.rearTireSize = '';
    this.frontRimSize = '';
    this.rearRimSize = '';
  }

  private clearVehicleData(): void {
    this.vin = '';
    this.vinStatus = '';
    this.vinDecoded.set({});
    this.vehicleMake = '';
    this.vehicleModel = '';
    this.vehicleYear = '';
    this.vehicleTrim = '';
    this.vehicleDoors = '';
    this.bedLength = '';
    this.cabType = '';
    this.engineModel = '';
    this.engineCylinders = '';
    this.transmissionStyle = '';
    this.vehicleColor = '';
    this.clearFitmentFields();
  }

  private canDiscardChanges(): boolean {
    return this.saving() || !this.hasCustomerChanges();
  }

  private async findTopDuplicate(
    payload: Omit<Customer, 'id'> & { id?: string },
    excludeId?: string
  ): Promise<DuplicateCandidate | null> {
    try {
      const res = await firstValueFrom(this.customersApi.findDuplicates({
        ...payload,
        excludeId: excludeId || payload.id
      }));
      const items = Array.isArray(res?.items) ? res.items : [];
      return items[0] || null;
    } catch {
      return null;
    }
  }

  private duplicateReasonsLabel(reasons: DuplicateReason[] | string[]): string {
    const normalized = Array.from(new Set((Array.isArray(reasons) ? reasons : [])
      .map(reason => String(reason || '').toLowerCase().trim())
      .filter(Boolean)));
    const labels = normalized.map(reason => {
      if (reason === 'email') return 'email match';
      if (reason === 'phone') return 'phone match';
      if (reason === 'name') return 'name match';
      return reason;
    });
    return labels.length ? labels.join(', ') : 'possible duplicate';
  }

  private applyStoredFitmentToDetails(details: Record<string, string>): void {
    const add = (label: string, value: unknown) => {
      const clean = this.cleanVinValue(value);
      if (clean) details[label] = clean;
    };
    add('Bolt pattern', this.boltPattern);
    add('Rear bolt pattern', this.rearBoltPattern);
    add('PCD (mm)', this.pcd);
    add('Rear PCD (mm)', this.rearPcd);
    add('Front tire size', this.frontTireSize);
    add('Rear tire size', this.rearTireSize);
    add('Front rim size', this.frontRimSize);
    add('Rear rim size', this.rearRimSize);
    add('Centre bore', this.centreBore);
    add('Wheel fasteners', this.wheelFasteners);
    add('Wheel torque', this.wheelTorque);
  }

  private lookupWheelFitment(params: {
    make: string;
    model: string;
    year: string;
    trim: string;
    details: Record<string, string>;
    silent: boolean;
    applyToForm: boolean;
    onSettled?: () => void;
  }): void {
    const query = new URLSearchParams();
    query.set('make', params.make);
    query.set('model', params.model);
    query.set('year', params.year);
    if (params.trim) query.set('trim', params.trim);
    query.set('region', 'usdm');

    this.http.get<FitmentLookupResponse>(`/api/fitment?${query.toString()}`).subscribe({
      next: res => {
        if (params.applyToForm) {
          this.applyFitmentFromLookup(res);
        }
        const nextDetails = { ...params.details };
        if (params.applyToForm) {
          this.applyStoredFitmentToDetails(nextDetails);
        } else {
          this.applyFitmentResponseToDetails(nextDetails, res);
        }
        if (res?.matched?.trim) {
          nextDetails['Fitment match'] = String(res.matched.trim);
        }
        this.vinDecoded.set(nextDetails);
        const fitment = res?.fitment || null;
        const hasFitment = !!fitment && Object.values(fitment).some(value => !!this.cleanVinValue(value));
        if (params.silent) {
          this.vinStatus = '';
        } else if (hasFitment) {
          this.vinStatus = 'VIN decoded and fitment loaded.';
        } else {
          this.vinStatus = 'VIN decoded. Fitment data was not found for this vehicle.';
        }
        params.onSettled?.();
      },
      error: () => {
        this.vinStatus = params.silent
          ? ''
          : 'VIN decoded. Fitment lookup unavailable (check Wheel-Size API key).';
        params.onSettled?.();
      }
    });
  }

  private applyFitmentResponseToDetails(details: Record<string, string>, response: FitmentLookupResponse): void {
    const fitment = response?.fitment;
    if (!fitment) return;
    const add = (label: string, value: unknown) => {
      const clean = this.cleanVinValue(value);
      if (clean) details[label] = clean;
    };
    add('Bolt pattern', fitment.boltPattern);
    add('Rear bolt pattern', fitment.rearBoltPattern);
    add('PCD (mm)', fitment.pcd);
    add('Rear PCD (mm)', fitment.rearPcd);
    add('Front tire size', fitment.frontTireSize);
    add('Rear tire size', fitment.rearTireSize);
    add('Front rim size', fitment.frontRimSize);
    add('Rear rim size', fitment.rearRimSize);
    add('Centre bore', fitment.centreBore);
    add('Wheel fasteners', fitment.wheelFasteners);
    add('Wheel torque', fitment.wheelTorque);
  }

  private applyFitmentFromLookup(response: FitmentLookupResponse): void {
    const fitment = response?.fitment;
    if (!fitment) return;
    const text = (value: unknown): string => this.cleanVinValue(value);

    const boltPattern = text(fitment.boltPattern);
    const rearBoltPattern = text(fitment.rearBoltPattern);
    const pcd = text(fitment.pcd);
    const rearPcd = text(fitment.rearPcd);
    const centreBore = text(fitment.centreBore);
    const wheelFasteners = text(fitment.wheelFasteners);
    const wheelTorque = text(fitment.wheelTorque);
    const frontTireSize = text(fitment.frontTireSize);
    const rearTireSize = text(fitment.rearTireSize);
    const frontRimSize = text(fitment.frontRimSize);
    const rearRimSize = text(fitment.rearRimSize);

    if (boltPattern) this.boltPattern = boltPattern;
    if (rearBoltPattern) this.rearBoltPattern = rearBoltPattern;
    if (pcd) this.pcd = pcd;
    if (rearPcd) this.rearPcd = rearPcd;
    if (centreBore) this.centreBore = centreBore;
    if (wheelFasteners) this.wheelFasteners = wheelFasteners;
    if (wheelTorque) this.wheelTorque = wheelTorque;
    if (frontTireSize) this.frontTireSize = frontTireSize;
    if (rearTireSize) this.rearTireSize = rearTireSize;
    if (frontRimSize) this.frontRimSize = frontRimSize;
    if (rearRimSize) this.rearRimSize = rearRimSize;
  }

  private isTab(value: string): value is CustomerTab {
    return value === 'notes' || value === 'schedule' || value === 'sms' || value === 'invoices' || value === 'email';
  }

  private normalizeTab(value: string): CustomerTab | null {
    if (this.isTab(value)) return value;
    if (value === 'email-history') return 'email';
    if (value === 'scheduled') return 'schedule';
    if (value === 'profile' || value === 'vehicle') return 'notes';
    return null;
  }

  private composeWithSignature(body: string): string {
    const base = String(body || '').trim();
    const signature = this.emailSignature().trim();
    if (!signature) return base;
    if (!base) return `--\n${signature}`;
    return `${base}\n\n--\n${signature}`;
  }

  private isValidEmailAddress(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
  }

  private normalizeE164(value: string): string | null {
    const digits = (value || '').replace(/\D+/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
    return null;
  }

  private cleanVinValue(value: unknown): string {
    const text = String(value ?? '').trim();
    if (!text) return '';
    const normalized = text.toLowerCase();
    if (normalized === 'not applicable' || normalized === 'na' || normalized === 'null' || normalized === 'unknown') {
      return '';
    }
    if (/^0+(\.0+)?$/.test(text)) return '';
    return text;
  }

  private buildCustomerSnapshot(): string {
    return JSON.stringify({
      firstName: this.firstName.trim(),
      lastName: this.lastName.trim(),
      phone: this.phone.trim(),
      email: this.email.trim(),
      address: this.address.trim(),
      notes: this.notes.trim(),
      vin: this.vin.trim(),
      vehicleMake: this.vehicleMake.trim(),
      vehicleModel: this.vehicleModel.trim(),
      vehicleYear: this.vehicleYear.trim(),
      vehicleTrim: this.vehicleTrim.trim(),
      vehicleDoors: this.vehicleDoors.trim(),
      bedLength: this.bedLength.trim(),
      cabType: this.cabType.trim(),
      engineModel: this.engineModel.trim(),
      engineCylinders: this.engineCylinders.trim(),
      transmissionStyle: this.transmissionStyle.trim(),
      boltPattern: this.boltPattern.trim(),
      rearBoltPattern: this.rearBoltPattern.trim(),
      pcd: this.pcd.trim(),
      rearPcd: this.rearPcd.trim(),
      centreBore: this.centreBore.trim(),
      wheelFasteners: this.wheelFasteners.trim(),
      wheelTorque: this.wheelTorque.trim(),
      frontTireSize: this.frontTireSize.trim(),
      rearTireSize: this.rearTireSize.trim(),
      frontRimSize: this.frontRimSize.trim(),
      rearRimSize: this.rearRimSize.trim(),
      vehicleColor: this.vehicleColor.trim()
    });
  }

  private captureInitialSnapshot(): void {
    this.initialCustomerSnapshot = this.buildCustomerSnapshot();
  }

  private isAddressValid(): boolean {
    const value = this.address.trim();
    if (!value) return true;
    return this.addressValidated();
  }

  private queueAddressLookup(raw: string): void {
    if (this.addressSearchTimer) {
      clearTimeout(this.addressSearchTimer);
      this.addressSearchTimer = null;
    }
    this.addressLookupSub?.unsubscribe();
    this.addressSearching.set(false);

    const query = raw.trim();
    if (query.length < 4) {
      this.addressSuggestions.set([]);
      this.addressNoMatches.set(false);
      return;
    }

    this.addressSearchTimer = setTimeout(() => this.lookupAddressSuggestions(query), 360);
  }

  private lookupAddressSuggestions(query: string): void {
    this.addressSearching.set(true);
    this.addressNoMatches.set(false);
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=us&q=${encodeURIComponent(query)}`;
    this.addressLookupSub = this.http.get<any[]>(url, {
      headers: {
        'Accept-Language': 'en-US'
      }
    })
      .pipe(finalize(() => this.addressSearching.set(false)))
      .subscribe({
        next: items => {
          const suggestions = (Array.isArray(items) ? items : [])
            .map(item => {
              const addr = item?.address || {};
              const line1 = [addr.house_number, addr.road].filter(Boolean).join(' ').trim();
              const city = [addr.city, addr.town, addr.village, addr.hamlet].find(Boolean);
              const line2 = [city, addr.state, addr.postcode].filter(Boolean).join(', ').trim();
              const display = [line1, line2].filter(Boolean).join(', ').trim() || String(item?.display_name || '').trim();
              return {
                id: String(item?.place_id || `${display}-${item?.lat || ''}-${item?.lon || ''}`),
                display
              } as AddressSuggestion;
            })
            .filter(item => !!item.display);
          this.addressSuggestions.set(suggestions);
          this.addressNoMatches.set(query.length >= 4 && suggestions.length === 0);
        },
        error: () => {
          this.addressSuggestions.set([]);
          this.addressNoMatches.set(true);
        }
      });
  }

  private colorForSeed(seed: string): string {
    const palette = ['#1d4ed8', '#0f766e', '#b45309', '#be185d', '#4c1d95', '#374151', '#0f766e'];
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(i);
      hash |= 0;
    }
    return palette[Math.abs(hash) % palette.length];
  }

  private extractError(err: unknown, fallback: string): string {
    if (err instanceof HttpErrorResponse) {
      const detail = typeof err.error === 'object' && err.error !== null
        ? (err.error.detail || err.error.error || err.message)
        : err.message;
      return `${fallback} ${String(detail)}`.trim();
    }
    return fallback;
  }

  private updateMobileLayoutState(): void {
    if (typeof window === 'undefined') return;
    const next = window.innerWidth <= 980;
    const previous = this.isMobileLayout();
    this.isMobileLayout.set(next);
    if (next && !previous) {
      this.mobileTab.set('profile');
    }
    if (!next) {
      this.mobileTab.set('profile');
    }
  }
}
