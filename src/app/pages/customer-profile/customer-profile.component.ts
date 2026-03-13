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
  IonModal,
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
import { InvoiceCard, InvoiceDetail, InvoicesDataService } from '../../services/invoices-data.service';
import { AuthService } from '../../auth/auth.service';
import { TenantContextService } from '../../services/tenant-context.service';
import { BrandSettingsService } from '../../services/brand-settings.service';
import { BusinessProfileService } from '../../services/business-profile.service';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { formatLocalDateTime, toLocalDateTimeInput, toLocalDateTimeStorage } from '../../utils/datetime-local';
import { environment } from '../../../environments/environment';

type CustomerTab = 'vehicle' | 'schedule' | 'invoices' | 'sms' | 'email';
type CustomerMobileTab = 'profile' | CustomerTab;
type CustomerDocsFilter = 'all' | 'open' | 'paid' | 'canceled';
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
type DuplicateSavePrompt = {
  mode: 'create' | 'update';
  candidate: DuplicateCandidate;
  payload: Omit<Customer, 'id'> & { id?: string };
};
type CustomerNoteHistoryEntry = {
  id: string;
  text: string;
  createdAt: string;
  createdBy: string;
  createdById?: string;
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
    IonModal,
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
  private readonly customerMessagesFetchLimit = 300;

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly customersApi = inject(CustomersApi);
  private readonly smsApi = inject(SmsApiService);
  private readonly emailApi = inject(EmailApiService);
  private readonly scheduleApi = inject(ScheduleApi);
  private readonly appSettingsApi = inject(AppSettingsApiService);
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly auth = inject(AuthService);
  private readonly tenantContext = inject(TenantContextService);
  private readonly branding = inject(BrandSettingsService);
  private readonly businessProfile = inject(BusinessProfileService);

  private routeSub: Subscription | null = null;
  private querySub: Subscription | null = null;
  private addressLookupSub: Subscription | null = null;
  private unreadActivityTimer: ReturnType<typeof setInterval> | null = null;
  private addressSearchTimer: ReturnType<typeof setTimeout> | null = null;
  private initialCustomerSnapshot = '';
  private smsThreadCache: SmsThreadCache = {};
  private ignoredDuplicatePairs = new Set<string>();

  readonly customerId = signal<string | null>(null);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly status = signal('');
  readonly error = signal('');
  readonly duplicateMatches = signal<DuplicateCandidate[]>([]);
  readonly duplicateLoading = signal(false);
  readonly duplicateSavePrompt = signal<DuplicateSavePrompt | null>(null);
  readonly validationAttempted = signal(false);
  readonly deleteModalOpen = signal(false);
  readonly activeTab = signal<CustomerTab>('vehicle');
  readonly isMobileLayout = signal(false);
  readonly mobileTab = signal<CustomerMobileTab>('profile');

  firstName = '';
  lastName = '';
  phone = '';
  secondaryPhone = '';
  email = '';
  secondaryEmail = '';
  showSecondaryPhone = false;
  showSecondaryEmail = false;
  address = '';
  notes = '';
  notesHistory: CustomerNoteHistoryEntry[] = [];
  noteDraft = '';
  customerCreatedAt = '';

  vin = '';
  vinStatus = '';
  private vinDecodeLockedFor = '';
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
    vehicle: false,
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
    { key: 'vehicle', label: 'Vehicle', icon: 'car-outline' },
    { key: 'schedule', label: 'Scheduled', icon: 'calendar-outline' },
    { key: 'invoices', label: 'Quotes & Invoices', icon: 'cash-outline' },
    { key: 'sms', label: 'SMS History', icon: 'chatbubble-ellipses-outline' },
    { key: 'email', label: 'Email History', icon: 'mail-outline' }
  ];
  readonly mobileTabs: Array<{ key: CustomerMobileTab; label: string; icon: string }> = [
    { key: 'profile', label: 'Profile', icon: 'person-outline' },
    { key: 'vehicle', label: 'Vehicle', icon: 'car-outline' },
    { key: 'schedule', label: 'Scheduled', icon: 'calendar-outline' },
    { key: 'invoices', label: 'Quotes & Invoices', icon: 'cash-outline' },
    { key: 'sms', label: 'SMS', icon: 'chatbubble-ellipses-outline' },
    { key: 'email', label: 'Email', icon: 'mail-outline' }
  ];
  readonly docsFilter = signal<CustomerDocsFilter>('open');
  readonly refundSubmitting = signal(false);
  readonly refundStatus = signal('');
  readonly refundError = signal('');
  readonly docFilterOptions: Array<{ id: CustomerDocsFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'open', label: 'Open' },
    { id: 'paid', label: 'Paid/Complete' },
    { id: 'canceled', label: 'Cancelled' }
  ];
  refundInvoiceId = '';
  refundAmount = '';
  refundReason = '';

  customerInvoices(): InvoiceCard[] {
    const fullName = `${this.firstName} ${this.lastName}`.trim();
    const docs = this.invoicesData.forCustomer({
      id: this.customerId(),
      email: this.email,
      name: fullName || null
    });
    return docs.filter(doc => !this.isConvertedQuote(doc));
  }

  filteredCustomerInvoices(): InvoiceCard[] {
    const filter = this.docsFilter();
    const docs = this.customerInvoices();
    if (filter === 'all') return docs;
    if (filter === 'open') {
      return docs.filter(doc =>
        doc.stage === 'draft'
        || doc.stage === 'sent'
        || (doc.documentType === 'quote' && doc.stage === 'accepted')
      );
    }
    if (filter === 'paid') {
      return docs.filter(doc => doc.documentType === 'invoice' && doc.stage === 'accepted');
    }
    return docs.filter(doc => doc.stage === 'canceled' || doc.stage === 'declined' || doc.stage === 'expired');
  }

  invoiceAttentionCount(): number {
    return this.customerInvoices()
      .filter(invoice =>
        invoice.stage === 'draft'
        || invoice.stage === 'sent'
        || (invoice.documentType === 'quote' && invoice.stage === 'accepted')
      )
      .length;
  }

  refundableInvoices(): InvoiceCard[] {
    return this.customerInvoices()
      .filter(doc => doc.documentType === 'invoice' && doc.stage === 'accepted')
      .sort((a, b) => {
        const at = Date.parse(String(a.invoicedAt || '').trim());
        const bt = Date.parse(String(b.invoicedAt || '').trim());
        if (Number.isFinite(bt) && Number.isFinite(at)) return bt - at;
        if (Number.isFinite(bt)) return 1;
        if (Number.isFinite(at)) return -1;
        return 0;
      });
  }

  onRefundInvoiceChange(value: string): void {
    this.refundInvoiceId = String(value || '').trim();
    this.refundStatus.set('');
    this.refundError.set('');
    if (!this.refundInvoiceId) return;
    const detail = this.refundInvoiceDetail();
    const max = Number(detail?.paidAmount || detail?.total || 0);
    if (Number.isFinite(max) && max > 0) {
      this.refundAmount = max.toFixed(2);
    }
  }

  async issueRefund(): Promise<void> {
    if (this.refundSubmitting()) return;
    this.refundStatus.set('');
    this.refundError.set('');

    const invoiceId = String(this.refundInvoiceId || '').trim();
    if (!invoiceId) {
      this.refundError.set('Choose an invoice to refund.');
      return;
    }

    const detail = this.refundInvoiceDetail();
    if (!detail || detail.documentType !== 'invoice') {
      this.refundError.set('Selected invoice could not be loaded.');
      return;
    }

    const amount = Number(String(this.refundAmount || '').replace(/[^0-9.\-]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      this.refundError.set('Enter a valid refund amount.');
      return;
    }
    const paid = Number(detail.paidAmount || detail.total || 0);
    if (Number.isFinite(paid) && paid > 0 && amount > paid) {
      this.refundError.set(`Refund amount cannot exceed paid amount (${this.formatUsd(paid)}).`);
      return;
    }

    const reason = String(this.refundReason || '').trim();
    const refund = this.invoicesData.recordRefund(detail.id, amount, reason || undefined);
    if (!refund) {
      this.refundError.set('Could not record refund. Try again.');
      return;
    }

    this.refundSubmitting.set(true);
    try {
      const to = String(refund.customerEmail || this.email || '').trim();
      if (to) {
        const business = String(refund.businessName || this.businessProfile.companyName() || 'Your service team').trim();
        const amountLabel = this.formatUsd(amount);
        const reasonLine = reason ? `Reason: ${reason}` : 'Reason: not specified.';
        const subject = `Refund issued for ${refund.invoiceNumber}`;
        const plain = `Hi ${refund.customerName || this.displayName() || 'Customer'}, a refund of ${amountLabel} was issued for invoice ${refund.invoiceNumber}. ${reasonLine}`;
        const html = `<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111827;">
          <p>Hi ${this.escapeHtml(refund.customerName || this.displayName() || 'Customer')},</p>
          <p>A refund of <strong>${this.escapeHtml(amountLabel)}</strong> was issued for invoice <strong>${this.escapeHtml(refund.invoiceNumber)}</strong>.</p>
          <p>${this.escapeHtml(reasonLine)}</p>
          <p>${this.escapeHtml(business)}</p>
        </div>`;
        await firstValueFrom(this.emailApi.sendToCustomer({
          customerId: String(refund.customerId || this.customerId() || '').trim(),
          customerName: refund.customerName || this.displayName() || 'Customer',
          to,
          subject,
          message: plain,
          html
        }));
      }

      this.refundStatus.set(`Refund recorded for ${refund.invoiceNumber}.`);
      this.refundAmount = '';
      this.refundReason = '';
      this.refundInvoiceId = '';
    } catch {
      this.refundStatus.set(`Refund recorded for ${refund.invoiceNumber}, but customer notification failed.`);
    } finally {
      this.refundSubmitting.set(false);
    }
  }

  private refundInvoiceDetail(): InvoiceDetail | null {
    const invoiceId = String(this.refundInvoiceId || '').trim();
    if (!invoiceId) return null;
    return this.invoicesData.getInvoiceById(invoiceId);
  }

  private formatUsd(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(Number(value || 0));
  }

  setDocsFilter(value: CustomerDocsFilter): void {
    this.docsFilter.set(value);
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
        this.duplicateMatches.set([]);
        this.duplicateLoading.set(false);
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

  openSmsFromPhone(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    if (!this.customerId()) return;
    this.selectTab('sms');
  }

  canDeactivate(): boolean {
    if (this.canDiscardChanges()) return true;
    return window.confirm('You have unsaved changes. Leave without saving?');
  }

  async saveCustomer(): Promise<void> {
    this.status.set('');
    this.error.set('');
    this.duplicateSavePrompt.set(null);
    this.validationAttempted.set(true);
    const first = this.firstName.trim();
    const last = this.lastName.trim();
    const phone = this.phone.trim();
    const secondaryPhone = this.secondaryPhone.trim();
    const email = this.email.trim();
    const secondaryEmail = this.secondaryEmail.trim();
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
    if (!this.isSecondaryPhoneValid()) {
      this.error.set('Secondary phone must be a valid phone number.');
      return;
    }

    if (!this.isEmailValid()) {
      this.error.set('A valid email address is required.');
      return;
    }
    if (!this.isSecondaryEmailValid()) {
      this.error.set('Secondary email must be a valid email address.');
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
      mobile: secondaryPhone,
      email,
      secondaryEmail,
      address: this.toStoredAddress(this.address),
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
      notes: this.notes.trim(),
      notesHistory: this.notesHistoryPayload()
    };

    if (!payload.id) {
      payload.createdAt = new Date().toISOString();
    }

    try {
      const currentId = this.customerId();

      if (!currentId) {
        const duplicate = await this.findTopDuplicate(payload);
        if (duplicate) {
          this.duplicateSavePrompt.set({ mode: 'create', candidate: duplicate, payload });
          this.error.set('Possible duplicate found. Choose merge or save as separate.');
          return;
        }
      } else {
        const duplicate = await this.findTopDuplicate(payload, currentId);
        if (duplicate) {
          this.duplicateSavePrompt.set({ mode: 'update', candidate: duplicate, payload });
          this.error.set('Possible duplicate found. Choose merge or save as separate.');
          return;
        }
      }

      await this.persistCustomer(payload);
    } catch (err) {
      this.error.set(this.extractError(err, 'Could not save customer.'));
    } finally {
      this.saving.set(false);
    }
  }

  goBack(): void {
    this.router.navigate(['/customers']);
  }

  canDeleteCustomer(): boolean {
    return this.auth.isAdmin() && !!this.customerId();
  }

  openDeleteCustomerModal(): void {
    const customerId = String(this.customerId() || '').trim();
    if (!customerId) {
      this.error.set('Save this customer first before deleting.');
      return;
    }
    if (!this.auth.isAdmin()) {
      this.error.set('Only admins can delete customers.');
      return;
    }
    this.deleteModalOpen.set(true);
  }

  cancelDeleteCustomerModal(): void {
    this.deleteModalOpen.set(false);
  }

  async confirmDeleteCustomerFromModal(): Promise<void> {
    const customerId = String(this.customerId() || '').trim();
    if (!customerId) return;
    this.deleteModalOpen.set(false);

    this.saving.set(true);
    this.status.set('');
    this.error.set('');
    try {
      await firstValueFrom(this.customersApi.delete(customerId));
      this.status.set('Customer deleted.');
      await this.router.navigate(['/customers'], { replaceUrl: true });
    } catch (err) {
      this.error.set(this.extractError(err, 'Could not delete customer.'));
    } finally {
      this.saving.set(false);
    }
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
    if (invoice.documentType === 'quote') {
      const quoteIdentifier = String(invoiceId || invoice.invoiceNumber).trim();
      void this.router.navigate(['/quotes', quoteIdentifier]);
      return;
    }
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
    lockUntilInputChange?: boolean;
    onSettled?: () => void;
  }): void {
    const silent = !!options?.silent;
    const hydrateVehicleFields = options?.hydrateVehicleFields !== false;
    const hydrateFitmentFields = options?.hydrateFitmentFields ?? !silent;
    const lockUntilInputChange = options?.lockUntilInputChange !== false;
    const onSettled = options?.onSettled;
    const settle = () => onSettled?.();
    const vin = this.vin.trim().toUpperCase();
    this.vin = vin;
    if (lockUntilInputChange && vin) {
      this.vinDecodeLockedFor = vin;
    }
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

  onVinInputChange(value: string | null | undefined): void {
    const normalized = String(value || '').toUpperCase().trim();
    this.vin = normalized;
    if (this.vinDecodeLockedFor && this.vinDecodeLockedFor !== normalized) {
      this.vinDecodeLockedFor = '';
    }
  }

  canDecodeVin(): boolean {
    const normalized = this.vin.trim().toUpperCase();
    if (!normalized) return false;
    return normalized !== this.vinDecodeLockedFor;
  }

  loadSmsThread(): void {
    const customerId = this.customerId();
    if (!customerId) return;
    this.smsLoading.set(true);
    this.smsError.set('');
    this.smsApi
      .listCustomerMessages(customerId, this.customerMessagesFetchLimit)
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
      .listCustomerMessages(customerId, this.customerMessagesFetchLimit)
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
    this.emailTo = this.email.trim() || this.secondaryEmail.trim();
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
    const merge = this.emailMergeTagValues();
    this.emailSubject = this.resolveEmailMergeTags(template.subject, merge);
    this.emailMessage = this.composeWithSignature(this.resolveEmailMergeTags(template.body, merge));
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

    const mergeValues = this.emailMergeTagValues();
    const to = this.resolveEmailMergeTags(this.emailTo.trim(), mergeValues);
    const subject = this.resolveEmailMergeTags(this.emailSubject.trim(), mergeValues);
    const message = this.resolveEmailMergeTags(this.emailMessage.trim(), mergeValues);
    const html = this.looksLikeHtmlContent(message) ? this.normalizeEmailHtmlAssets(message) : '';
    const textMessage = html ? this.htmlToPlainText(message) : message;

    if (!this.isValidEmailAddress(to)) {
      this.emailError.set('Enter a valid recipient email.');
      return;
    }
    if (!subject) {
      this.emailError.set('Email subject is required.');
      return;
    }
    if (!textMessage) {
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
        message: textMessage,
        html: html || undefined
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
            message: textMessage,
            html: html || null,
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
    if (invoice.documentType === 'invoice' && invoice.stage === 'accepted') return 'Paid';
    if (invoice.stage === 'completed') return 'Completed';
    if (invoice.documentType === 'quote' && invoice.stage === 'accepted') return 'Accepted';
    if (invoice.stage === 'draft') return 'Draft';
    if (invoice.stage === 'sent') return 'Sent';
    if (invoice.stage === 'declined') return 'Declined';
    if (invoice.stage === 'canceled') return 'Cancelled';
    if (invoice.stage === 'expired') return 'Expired';
    return `${invoice.stage.charAt(0).toUpperCase()}${invoice.stage.slice(1)}`;
  }

  invoiceBadgeColor(invoice: InvoiceCard): string {
    if (invoice.stage === 'accepted' || invoice.stage === 'completed') return 'success';
    if (invoice.stage === 'declined') return 'danger';
    if (invoice.stage === 'canceled') return 'danger';
    if (invoice.stage === 'expired') return 'medium';
    if (invoice.stage === 'draft') return 'warning';
    if (invoice.stage === 'sent') return 'primary';
    return 'medium';
  }

  private isConvertedQuote(invoice: InvoiceCard): boolean {
    if (invoice.documentType !== 'quote') return false;
    if (invoice.stage !== 'canceled') return false;
    const detail = this.invoicesData.getInvoiceById(invoice.id);
    const timeline = Array.isArray(detail?.timeline) ? detail!.timeline : [];
    return timeline.some(entry => /converted to invoice/i.test(String(entry?.message || '')));
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

  isSecondaryEmailValid(): boolean {
    const value = this.secondaryEmail.trim();
    return !value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  isPhoneValid(): boolean {
    return !!this.normalizeE164(this.phone.trim());
  }

  isSecondaryPhoneValid(): boolean {
    const value = this.secondaryPhone.trim();
    return !value || !!this.normalizeE164(value);
  }

  isVehicleYearValid(): boolean {
    const year = this.vehicleYear.trim();
    if (!year) return true;
    return /^\d{4}$/.test(year);
  }

  showInlineValidation(): boolean {
    return this.validationAttempted();
  }

  hasCustomerChanges(): boolean {
    return this.buildCustomerSnapshot() !== this.initialCustomerSnapshot;
  }

  canSaveCustomer(): boolean {
    return this.hasCustomerChanges() && this.isEmailValid() && this.isPhoneValid() && this.isVehicleYearValid() &&
      this.isSecondaryPhoneValid() &&
      this.isSecondaryEmailValid() &&
      this.isAddressValid() &&
      !!this.firstName.trim() && !!this.lastName.trim();
  }

  canSubmitSms(): boolean {
    return !!this.customerId() && !!this.outgoingMessage.trim();
  }

  hasNotesHistory(): boolean {
    return this.notesHistory.length > 0;
  }

  sortedNotesHistory(): CustomerNoteHistoryEntry[] {
    return [...this.notesHistory].sort((a, b) => {
      const aTime = Date.parse(a.createdAt || '');
      const bTime = Date.parse(b.createdAt || '');
      if (Number.isFinite(aTime) && Number.isFinite(bTime)) return bTime - aTime;
      if (Number.isFinite(aTime)) return -1;
      if (Number.isFinite(bTime)) return 1;
      return String(b.id || '').localeCompare(String(a.id || ''));
    });
  }

  canAddNote(): boolean {
    return !!this.noteDraft.trim();
  }

  addNoteEntry(): void {
    const text = this.noteDraft.trim();
    if (!text) return;
    const createdAt = new Date().toISOString();
    const author = this.currentNoteAuthor();
    const authorId = this.currentNoteAuthorId();
    const note: CustomerNoteHistoryEntry = {
      id: this.localNoteId(),
      text,
      createdAt,
      createdBy: author,
      createdById: authorId || undefined
    };
    this.notesHistory = [...this.notesHistory, note];
    this.noteDraft = '';
    this.notes = text;
    this.status.set('Note added. Click Save Customer to persist.');
    this.error.set('');
  }

  noteCreatedByLabel(note: CustomerNoteHistoryEntry): string {
    const value = String(note?.createdBy || '').trim();
    return value || 'Unknown user';
  }

  noteDateLabel(value: string): string {
    const parsed = Date.parse(String(value || '').trim());
    if (!Number.isFinite(parsed)) return 'Date unknown';
    return new Date(parsed).toLocaleString();
  }

  trackNote(_index: number, note: CustomerNoteHistoryEntry): string {
    return note.id;
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
    this.queueAddressLookup(this.address.replace(/\s+/g, ' '));
  }

  onAddressBlur(): void {
    const normalized = this.normalizeAddressText(this.address);
    if (normalized && !this.addressValidated()) {
      const exact = this.addressSuggestions().find(item => this.normalizeAddressText(item.display) === normalized);
      if (exact) {
        this.selectAddressSuggestion(exact);
      }
    }
    setTimeout(() => {
      this.addressSuggestions.set([]);
    }, 120);
  }

  selectAddressSuggestion(item: AddressSuggestion): void {
    this.address = this.toDisplayAddress(item.display);
    this.addressValidated.set(true);
    this.addressSuggestions.set([]);
    this.addressNoMatches.set(false);
  }

  addSecondaryPhone(): void {
    this.showSecondaryPhone = true;
  }

  addSecondaryEmail(): void {
    this.showSecondaryEmail = true;
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
            this.duplicateMatches.set([]);
            this.resetForm();
            return;
          }
          this.fillForm(customer);
          this.loadDuplicateMatchesForCurrent();
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
          this.duplicateMatches.set([]);
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
    this.secondaryPhone = customer.mobile || '';
    this.email = customer.email || '';
    this.secondaryEmail = customer.secondaryEmail || '';
    this.showSecondaryPhone = !!this.secondaryPhone.trim();
    this.showSecondaryEmail = !!this.secondaryEmail.trim();
    this.emailTo = customer.email || customer.secondaryEmail || '';
    this.emailSubject = '';
    this.emailMessage = '';
    this.selectedTemplateId = '';
    this.emailView.set('list');
    this.selectedEmailId.set(null);
    this.emailStatus.set('');
    this.emailError.set('');
    this.address = this.toDisplayAddress(customer.address || '');
    this.notes = customer.notes || '';
    this.notesHistory = this.normalizeNotesHistory(customer.notesHistory, customer.notes, customer);
    if (this.notesHistory.length) {
      this.notes = this.notesHistory[this.notesHistory.length - 1].text;
    }
    this.noteDraft = '';
    this.customerCreatedAt = customer.createdAt || '';
    this.vin = (customer.vin || '').toUpperCase();
    this.vinDecodeLockedFor = '';
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
    this.validationAttempted.set(false);
    this.duplicateSavePrompt.set(null);
    this.captureInitialSnapshot();
    if (this.vin) {
      this.lookupVIN({
        silent: true,
        hydrateVehicleFields: false,
        hydrateFitmentFields: false,
        lockUntilInputChange: false,
        onSettled: () => this.captureInitialSnapshot()
      });
    }
  }

  private resetForm(): void {
    this.firstName = '';
    this.lastName = '';
    this.phone = '';
    this.secondaryPhone = '';
    this.email = '';
    this.secondaryEmail = '';
    this.showSecondaryPhone = false;
    this.showSecondaryEmail = false;
    this.emailTo = '';
    this.emailSubject = '';
    this.emailMessage = '';
    this.selectedTemplateId = '';
    this.emailView.set('list');
    this.selectedEmailId.set(null);
    this.address = '';
    this.notes = '';
    this.notesHistory = [];
    this.noteDraft = '';
    this.customerCreatedAt = '';
    this.vin = '';
    this.vinDecodeLockedFor = '';
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
    this.refundInvoiceId = '';
    this.refundAmount = '';
    this.refundReason = '';
    this.refundSubmitting.set(false);
    this.refundStatus.set('');
    this.refundError.set('');
    this.duplicateMatches.set([]);
    this.duplicateLoading.set(false);
    this.duplicateSavePrompt.set(null);
    this.validationAttempted.set(false);
    this.captureInitialSnapshot();
  }

  reviewDuplicate(duplicateId?: string): void {
    const currentId = String(this.customerId() || '').trim();
    const otherId = String(duplicateId || this.duplicateMatches()[0]?.id || '').trim();
    if (!currentId || !otherId || currentId === otherId) {
      this.error.set('Could not open duplicate review for this customer.');
      return;
    }
    this.status.set('');
    this.error.set('');
    void this.router.navigate(['/customers/duplicates'], {
      queryParams: {
        current: currentId,
        other: otherId
      }
    });
  }

  dismissDuplicateSavePrompt(): void {
    this.duplicateSavePrompt.set(null);
    this.error.set('');
  }

  async ignoreDuplicateSavePrompt(): Promise<void> {
    const pending = this.duplicateSavePrompt();
    const currentId = String(this.customerId() || '').trim();
    const candidateId = String(pending?.candidate?.id || '').trim();
    if (!pending || pending.mode !== 'update' || !currentId || !candidateId || currentId === candidateId) {
      this.duplicateSavePrompt.set(null);
      this.error.set('');
      return;
    }

    this.saving.set(true);
    this.status.set('');
    this.error.set('');
    try {
      await firstValueFrom(this.customersApi.markNotDuplicate(currentId, candidateId));
      this.rememberIgnoredDuplicatePair(currentId, candidateId);
      this.duplicateSavePrompt.set(null);
      this.duplicateMatches.set(this.duplicateMatches().filter(item => String(item?.id || '').trim() !== candidateId));
      this.status.set('Duplicate ignored. This pair will not be flagged again.');
    } catch (err) {
      this.error.set(this.extractError(err, 'Could not ignore duplicate.'));
    } finally {
      this.saving.set(false);
    }
  }

  async saveAsSeparateAfterDuplicate(): Promise<void> {
    const pending = this.duplicateSavePrompt();
    if (!pending) return;
    this.duplicateSavePrompt.set(null);
    this.status.set('');
    this.error.set('');
    try {
      const savedId = await this.persistCustomer(pending.payload);
      const candidateId = String(pending?.candidate?.id || '').trim();
      if (savedId && candidateId && savedId !== candidateId) {
        try {
          await firstValueFrom(this.customersApi.markNotDuplicate(savedId, candidateId));
          this.rememberIgnoredDuplicatePair(savedId, candidateId);
        } catch {
          // Save succeeded; ignore persistence can fail without blocking.
        }
      }
    } catch (err) {
      this.error.set(this.extractError(err, 'Could not save customer.'));
    } finally {
      this.saving.set(false);
    }
  }

  async mergeAfterDuplicatePrompt(): Promise<void> {
    const pending = this.duplicateSavePrompt();
    if (!pending) return;
    this.status.set('');
    this.error.set('');
    this.saving.set(true);
    try {
      if (pending.mode === 'create') {
        const merged = await firstValueFrom(this.customersApi.mergeDraftInto(pending.candidate.id, pending.payload));
        const mergedId = merged.id || pending.candidate.id;
        this.duplicateSavePrompt.set(null);
        this.status.set('Customer merged into existing record.');
        this.customerId.set(mergedId);
        await this.router.navigate(['/customers', mergedId], {
          replaceUrl: true,
          queryParams: { tab: this.activeTab() }
        });
        this.captureInitialSnapshot();
        return;
      }

      const currentId = String(this.customerId() || '').trim();
      if (!currentId) {
        this.error.set('Current customer is missing. Save as separate instead.');
        return;
      }

      // Preserve unsaved edits by applying draft values to target before merge.
      await firstValueFrom(this.customersApi.mergeDraftInto(pending.candidate.id, pending.payload));
      const merged = await firstValueFrom(this.customersApi.mergeCustomers(pending.candidate.id, currentId));
      const mergedId = merged.id || pending.candidate.id;
      this.duplicateSavePrompt.set(null);
      this.status.set('Customers merged.');
      this.customerId.set(mergedId);
      await this.router.navigate(['/customers', mergedId], {
        replaceUrl: true,
        queryParams: { tab: this.activeTab() }
      });
      this.captureInitialSnapshot();
    } catch (err) {
      this.error.set(this.extractError(err, 'Could not merge customers.'));
    } finally {
      this.saving.set(false);
    }
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
      vehicle: false,
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

  private localNoteId(): string {
    return `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
      const excluded = String(excludeId || payload.id || '').trim();
      const res = await firstValueFrom(this.customersApi.findDuplicates({
        ...payload,
        excludeId: excluded
      }));
      const items = (Array.isArray(res?.items) ? res.items : [])
        .filter(item => !this.isDuplicatePairIgnored(excluded, String(item?.id || '').trim()));
      return items.find(item => this.duplicateConfidence(item) >= 55) || null;
    } catch {
      return null;
    }
  }

  private async persistCustomer(payload: Omit<Customer, 'id'> & { id?: string }): Promise<string> {
    this.saving.set(true);
    const res = await firstValueFrom(this.customersApi.upsert(payload));
    this.status.set('Customer saved.');
    this.error.set('');
    this.validationAttempted.set(false);
    const savedId = res.id;
    if (!this.customerId()) {
      this.customerId.set(savedId);
      await this.router.navigate(['/customers', savedId], {
        replaceUrl: true,
        queryParams: { tab: this.activeTab() }
      });
      this.captureInitialSnapshot();
      return savedId;
    }
    this.captureInitialSnapshot();
    return savedId;
  }

  private loadDuplicateMatchesForCurrent(): void {
    const currentId = String(this.customerId() || '').trim();
    if (!currentId) {
      this.duplicateMatches.set([]);
      this.duplicateLoading.set(false);
      return;
    }

    const probe = {
      id: currentId,
      firstName: this.firstName.trim(),
      lastName: this.lastName.trim(),
      name: `${this.firstName} ${this.lastName}`.trim(),
      email: this.email.trim(),
      secondaryEmail: this.secondaryEmail.trim(),
      phone: this.phone.trim(),
      vin: this.vin.trim(),
      excludeId: currentId
    };

    this.duplicateLoading.set(true);
    this.customersApi.findDuplicates(probe).pipe(
      finalize(() => this.duplicateLoading.set(false))
    ).subscribe({
      next: res => {
        const items = (Array.isArray(res?.items) ? res.items : [])
          .filter(item => !this.isDuplicatePairIgnored(currentId, String(item?.id || '').trim()))
          .filter(item => this.duplicateConfidence(item) >= 55);
        this.duplicateMatches.set(items);
      },
      error: () => {
        this.duplicateMatches.set([]);
      }
    });
  }

  duplicateReasonsLabel(reasons: DuplicateReason[] | string[]): string {
    const normalized = Array.from(new Set((Array.isArray(reasons) ? reasons : [])
      .map(reason => String(reason || '').toLowerCase().trim())
      .filter(Boolean)));
    const labels = normalized.map(reason => {
      if (reason === 'vin') return 'VIN match';
      if (reason === 'email') return 'email match';
      if (reason === 'phone') return 'phone match';
      if (reason === 'name') return 'name match';
      return reason;
    });
    return labels.length ? labels.join(', ') : 'possible duplicate';
  }

  duplicateConfidence(candidate: DuplicateCandidate | null | undefined): number {
    const raw = Number(candidate?.confidence);
    if (Number.isFinite(raw) && raw >= 0) return Math.max(0, Math.min(100, Math.round(raw)));
    const score = Number(candidate?.score);
    if (!Number.isFinite(score) || score < 0) return 0;
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  duplicateRecommendationLabel(candidate: DuplicateCandidate | null | undefined): string {
    const recommendation = String(candidate?.recommendation || '').trim().toLowerCase();
    if (recommendation === 'auto-merge') return 'Auto-merge recommended';
    if (recommendation === 'review') return 'Manual review recommended';
    return 'Possible duplicate';
  }

  async ignoreDuplicateForCurrent(duplicateId?: string): Promise<void> {
    const currentId = String(this.customerId() || '').trim();
    const otherId = String(duplicateId || this.duplicateMatches()[0]?.id || '').trim();
    if (!currentId || !otherId || currentId === otherId) {
      this.error.set('Could not ignore duplicate for this customer.');
      return;
    }

    this.status.set('');
    this.error.set('');
    this.saving.set(true);
    try {
      await firstValueFrom(this.customersApi.markNotDuplicate(currentId, otherId));
      this.rememberIgnoredDuplicatePair(currentId, otherId);
      this.duplicateMatches.set(this.duplicateMatches().filter(item => String(item?.id || '').trim() !== otherId));
      this.status.set('Duplicate match ignored. It will not be flagged again.');
    } catch (err) {
      this.error.set(this.extractError(err, 'Could not ignore duplicate.'));
    } finally {
      this.saving.set(false);
    }
  }

  private duplicatePairKey(leftId: string, rightId: string): string {
    const a = String(leftId || '').trim();
    const b = String(rightId || '').trim();
    if (!a || !b || a === b) return '';
    return a < b ? `${a}::${b}` : `${b}::${a}`;
  }

  private rememberIgnoredDuplicatePair(leftId: string, rightId: string): void {
    const key = this.duplicatePairKey(leftId, rightId);
    if (!key) return;
    this.ignoredDuplicatePairs.add(key);
  }

  private isDuplicatePairIgnored(leftId: string, rightId: string): boolean {
    const key = this.duplicatePairKey(leftId, rightId);
    if (!key) return false;
    return this.ignoredDuplicatePairs.has(key);
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
    return value === 'vehicle' || value === 'schedule' || value === 'sms' || value === 'invoices' || value === 'email';
  }

  private normalizeTab(value: string): CustomerTab | null {
    if (this.isTab(value)) return value;
    if (value === 'email-history') return 'email';
    if (value === 'scheduled') return 'schedule';
    if (value === 'notes') return 'vehicle';
    if (value === 'profile') return 'vehicle';
    return null;
  }

  private composeWithSignature(body: string): string {
    const base = String(body || '').trim();
    const signature = this.emailSignature().trim();
    if (!signature) return base;

    if (this.looksLikeHtmlContent(base)) {
      return this.appendHtmlSignature(base, signature);
    }
    if (!base) return `--\n${signature}`;
    return `${base}\n\n--\n${signature}`;
  }

  private emailMergeTagValues(): Record<string, string> {
    const companyName = this.activeCompanyName();
    const logoUrl = this.toEmailAssetUrl(String(this.branding.logoUrl() || '').trim());
    const profile = this.businessProfile.profile();
    return {
      company_name: companyName,
      company_logo_url: logoUrl,
      company_email: profile.companyEmail || '',
      company_phone: profile.companyPhone || '',
      company_address: profile.companyAddress || '',
      company_location: profile.companyAddress || '',
      customer_name: this.displayName(),
      customer_email: this.email.trim() || this.secondaryEmail.trim(),
      customer_phone: this.phone.trim(),
      lead_message: this.notes.trim()
    };
  }

  private activeCompanyName(): string {
    const profileName = String(this.businessProfile.profile().companyName || '').trim();
    if (profileName) return profileName;
    const tenantId = String(this.tenantContext.tenantId() || '').trim();
    const locations = this.auth.locations();
    const selected = tenantId
      ? locations.find(location => String(location.id || '').trim() === tenantId)
      : null;
    const fallback = selected?.name || locations[0]?.name || '';
    return String(fallback || 'Your Company').trim();
  }

  private resolveEmailMergeTags(template: string, values: Record<string, string>): string {
    const source = String(template || '');
    if (!source) return '';
    return source.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_full, rawKey: string) => {
      const key = String(rawKey || '').toLowerCase();
      if (!key) return '';
      return String(values[key] ?? '').trim();
    });
  }

  private toEmailAssetUrl(value: string): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!raw.startsWith('/')) return raw;
    const publicBase = String(environment.publicAppUrl || '').trim().replace(/\/+$/, '');
    if (publicBase) return `${publicBase}${raw}`;
    if (typeof window !== 'undefined' && window.location?.origin) {
      return `${window.location.origin.replace(/\/+$/, '')}${raw}`;
    }
    return raw;
  }

  private looksLikeHtmlContent(value: string): boolean {
    return /<[^>]+>/.test(String(value || '').trim());
  }

  private htmlToPlainText(html: string): string {
    return String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeEmailHtmlAssets(html: string): string {
    const source = String(html || '');
    if (!source) return '';
    return source.replace(
      /(src|href)\s*=\s*(["'])(\/[^"']*)\2/gi,
      (_full, attr: string, quote: string, rawPath: string) => `${attr}=${quote}${this.toEmailAssetUrl(rawPath)}${quote}`
    );
  }

  private appendHtmlSignature(baseHtml: string, signature: string): string {
    const normalizedBase = String(baseHtml || '').trim();
    const normalizedSignature = String(signature || '').trim();
    if (!normalizedSignature) return normalizedBase;
    const signatureHtml = this.looksLikeHtmlContent(normalizedSignature)
      ? normalizedSignature
      : this.escapeHtml(normalizedSignature).replace(/\n/g, '<br/>');
    if (!normalizedBase) return signatureHtml;
    return `${normalizedBase}<br/><br/>${signatureHtml}`;
  }

  private escapeHtml(value: string): string {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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
      secondaryPhone: this.secondaryPhone.trim(),
      email: this.email.trim(),
      secondaryEmail: this.secondaryEmail.trim(),
      address: this.toStoredAddress(this.address),
      notes: this.notes.trim(),
      notesHistory: this.notesHistoryPayload(),
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

  private notesHistoryPayload(): Array<{ id: string; text: string; createdAt: string; createdBy: string; createdById: string }> {
    return this.notesHistory
      .map(note => ({
        id: String(note?.id || '').trim() || this.localNoteId(),
        text: String(note?.text || '').trim(),
        createdAt: String(note?.createdAt || '').trim(),
        createdBy: String(note?.createdBy || '').trim(),
        createdById: String(note?.createdById || '').trim()
      }))
      .filter(note => !!note.text)
      .map(note => ({
        ...note,
        createdAt: note.createdAt || new Date().toISOString(),
        createdBy: note.createdBy || 'Unknown user',
        createdById: note.createdById || ''
      }));
  }

  private normalizeNotesHistory(
    raw: unknown,
    legacyNotes: string | undefined,
    customer?: Customer | null
  ): CustomerNoteHistoryEntry[] {
    const source = Array.isArray(raw) ? raw : [];
    const out: CustomerNoteHistoryEntry[] = [];

    for (const item of source) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const text = String(record['text'] || '').trim();
      if (!text) continue;
      const createdAtRaw = String(record['createdAt'] || '').trim();
      const createdBy = String(record['createdBy'] || '').trim() || 'Unknown user';
      out.push({
        id: String(record['id'] || '').trim() || this.localNoteId(),
        text,
        createdAt: createdAtRaw || String(customer?.updatedAt || customer?.createdAt || ''),
        createdBy,
        createdById: String(record['createdById'] || '').trim() || undefined
      });
    }

    const legacy = String(legacyNotes || '').trim();
    if (!out.length && legacy) {
      out.push({
        id: `legacy-${String(customer?.id || 'note')}`,
        text: legacy,
        createdAt: String(customer?.updatedAt || customer?.createdAt || ''),
        createdBy: 'Legacy note'
      });
    }

    return out;
  }

  private currentNoteAuthor(): string {
    const user = this.auth.user();
    const displayName = String(user?.displayName || '').trim();
    if (displayName) return displayName;
    const email = String(user?.email || '').trim();
    if (email) return email;
    return 'Unknown user';
  }

  private currentNoteAuthorId(): string {
    return String(this.auth.user()?.id || '').trim();
  }

  private captureInitialSnapshot(): void {
    this.initialCustomerSnapshot = this.buildCustomerSnapshot();
  }

  private toDisplayAddress(value: string): string {
    const raw = String(value || '').replace(/\r/g, '').trim();
    if (!raw) return '';
    if (raw.includes('\n')) {
      return raw
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join('\n');
    }
    const parts = raw
      .split(',')
      .map(part => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      return `${parts[0]}\n${parts.slice(1).join(', ')}`.trim();
    }
    return raw;
  }

  private toStoredAddress(value: string): string {
    const lines = String(value || '')
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean);
    if (lines.length <= 1) return lines[0] || '';
    return `${lines[0]}, ${lines.slice(1).join(', ')}`.replace(/\s+/g, ' ').trim();
  }

  private normalizeAddressText(value: string): string {
    return String(value || '')
      .replace(/\r/g, '')
      .replace(/\n/g, ',')
      .replace(/,+/g, ',')
      .replace(/\s+/g, ' ')
      .replace(/,\s*/g, ', ')
      .trim()
      .toLowerCase();
  }

  private isAddressValid(): boolean {
    const value = this.normalizeAddressText(this.address);
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
              const display = [line1, line2].filter(Boolean).join('\n').trim() || String(item?.display_name || '').trim();
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
