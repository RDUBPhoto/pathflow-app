import { Component, OnDestroy, OnInit, computed, effect, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonCheckbox,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonSelect,
  IonSelectOption,
  IonToggle,
  IonTextarea,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';
import { ActivatedRoute } from '@angular/router';
import { addIcons } from 'ionicons';
import {
  cloudUploadOutline,
  imageOutline,
  addOutline,
  linkOutline,
  refreshOutline,
  sendOutline,
  removeCircleOutline,
  settingsOutline,
  shieldCheckmarkOutline,
  chatbubbleEllipsesOutline,
  mailOutline,
  trashOutline,
  saveOutline,
  codeSlashOutline,
  copyOutline,
  cardOutline
} from 'ionicons/icons';
import { Subscription, catchError, finalize, firstValueFrom, forkJoin, of } from 'rxjs';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { BrandSettingsService } from '../../services/brand-settings.service';
import { BrandingApi } from '../../services/branding-api.service';
import { SmsApiService, SmsConfigResponse } from '../../services/sms-api.service';
import {
  EmailApiService,
  EmailConfigResponse,
  EmailTemplate,
  EmailTemplatesResponse,
  EmailSenderConfig
} from '../../services/email-api.service';
import { InventoryApiService, InventoryConnector, InventoryItem } from '../../services/inventory-api.service';
import { AppSettingsApiService } from '../../services/app-settings-api.service';
import { BusinessProfileService } from '../../services/business-profile.service';
import { AddressLookupService, AddressSuggestion } from '../../services/address-lookup.service';
import { TenantContextService } from '../../services/tenant-context.service';
import { AuthService } from '../../auth/auth.service';
import { environment } from '../../../environments/environment';
import { AccessAdminApiService, WorkspaceUser } from '../../services/access-admin-api.service';
import {
  PaymentGatewayProviderKey,
  PaymentGatewaySettingsService
} from '../../services/payment-gateway-settings.service';
import {
  CustomerImportResponse,
  CustomerImportRow,
  CustomersApi
} from '../../services/customers-api.service';
import * as XLSX from 'xlsx';

interface AppIntegration {
  key: string;
  name: string;
  connected: boolean;
  summary: string;
}

type Bay = { id: string; name: string };
type ScheduleSettings = {
  bays: Bay[];
  openHour: number;
  closeHour: number;
  showWeekends: boolean;
  holidays: string[];
  federalYear: number;
  federalInitialized: boolean;
};
type LaborRate = {
  id: string;
  name: string;
  price: number;
  taxable: boolean;
};

type DocumentTemplateType = 'quote' | 'invoice' | 'both';
type DocumentTemplate = {
  id: string;
  name: string;
  documentType: DocumentTemplateType;
  subject: string;
  body: string;
  partItemIds: string[];
  laborRateIds: string[];
};

const ADMIN_INTEGRATIONS_SETTING_KEY = 'admin.integrations';
const SCHEDULE_SETTINGS_KEY = 'schedule.settings';
const EMAIL_FOOTER_TERMS_SETTING_KEY = 'email.footer.terms.html';
const LEGACY_QUOTE_TERMS_SETTING_KEY = 'quote.terms.html';
const BUSINESS_TAX_RATE_SETTING_KEY = 'business.tax.rate';
const BUSINESS_LABOR_RATES_SETTING_KEY = 'business.labor.rates';
const BUSINESS_DOCUMENT_TEMPLATES_SETTING_KEY = 'business.document.templates';
const AUTHORIZE_NET_CREDENTIALS_SETTING_KEY = 'billing.paymentProviders.authorizeNetCredentials';
const DEFAULT_ADMIN_USERS: WorkspaceUser[] = [
  {
    id: 'u-1',
    name: 'Shop Owner',
    email: 'owner@yourcompany.com',
    role: 'admin',
    status: 'active'
  },
  {
    id: 'u-2',
    name: 'Service Advisor',
    email: 'advisor@yourcompany.com',
    role: 'user',
    status: 'active'
  },
  {
    id: 'u-3',
    name: 'Operations Lead',
    email: 'ops@yourcompany.com',
    role: 'user',
    status: 'invited'
  }
];
const DEFAULT_INTEGRATIONS: AppIntegration[] = [
  {
    key: 'quickbooks',
    name: 'QuickBooks',
    connected: false,
    summary: 'Invoice sync and payment reconciliation'
  },
  {
    key: 'shopmonkey',
    name: 'Shopmonkey',
    connected: true,
    summary: 'Work order and service status sync'
  },
  {
    key: 'sendgrid-email',
    name: 'SendGrid (Email)',
    connected: false,
    summary: 'Inbound/outbound customer email delivery'
  },
  {
    key: 'acs-sms',
    name: 'Azure Communication Services (SMS)',
    connected: false,
    summary: 'Texting for customer updates and service milestones'
  }
];

type AdminSectionKey =
  | 'branding'
  | 'payments'
  | 'subscription'
  | 'users'
  | 'customerImport'
  | 'schedule'
  | 'sms'
  | 'widget'
  | 'email'
  | 'integrations';

type AdminSection = {
  key: AdminSectionKey;
  label: string;
  description: string;
  icon: string;
};

type WidgetLeadResponse = {
  ok: boolean;
  customerId: string | null;
  customerName: string | null;
  customerCreated: boolean;
  leadId: string;
  leadCreated: boolean;
  duplicateLeadSkipped: boolean;
  sms?: {
    optInProvided: boolean;
    optInChecked: boolean;
    consentStatus: string;
    confirmationAttempted: boolean;
    confirmationSent: boolean;
    confirmationSimulated: boolean;
    confirmationStatus: string;
    confirmationMessageId: string | null;
    confirmationError: string | null;
  };
};

const ZIGAFLOW_EXPECTED_HEADERS = [
  'Business',
  'Account Manager',
  'Creator',
  'Position',
  'Title',
  'First Name',
  'Last Name',
  'Notes',
  'Tags',
  'Telephone',
  'Mobile',
  'Email',
  'Address 1',
  'Address 2',
  'Address 3',
  'Town',
  'County/State/Province',
  'State',
  'Postcode',
  'Country',
  'Account Reference',
  'Price List',
  'Payment Term',
  'Last Quote Activity',
  'Last Job Activity',
  'Last Invoice Activity',
  'Last Opportunity Activity',
  'Last Task Activity',
  'Date Left',
  'ContactTags'
] as const;

const CUSTOMER_IMPORT_TARGET_FIELDS: Array<{ key: keyof CustomerImportRow; label: string }> = [
  { key: 'business', label: 'Business' },
  { key: 'accountManager', label: 'Account Manager' },
  { key: 'creator', label: 'User (Logged in)' },
  { key: 'position', label: 'Position' },
  { key: 'title', label: 'Title' },
  { key: 'firstName', label: 'First Name' },
  { key: 'lastName', label: 'Last Name' },
  { key: 'name', label: 'Full Name' },
  { key: 'notes', label: 'Notes' },
  { key: 'tags', label: 'Tags' },
  { key: 'phone', label: 'Telephone' },
  { key: 'mobile', label: 'Mobile' },
  { key: 'email', label: 'Email' },
  { key: 'address', label: 'Address (single line)' },
  { key: 'address1', label: 'Address 1' },
  { key: 'address2', label: 'Address 2' },
  { key: 'address3', label: 'Address 3' },
  { key: 'town', label: 'City' },
  { key: 'county', label: 'County / State / Province' },
  { key: 'state', label: 'State' },
  { key: 'postcode', label: 'Postcode' },
  { key: 'country', label: 'Country' },
  { key: 'accountReference', label: 'Account Reference' },
  { key: 'priceList', label: 'Price List' },
  { key: 'paymentTerm', label: 'Payment Term' },
  { key: 'lastQuoteActivity', label: 'Last Quote Activity' },
  { key: 'lastJobActivity', label: 'Last Job Activity' },
  { key: 'lastInvoiceActivity', label: 'Last Invoice Activity' },
  { key: 'lastOpportunityActivity', label: 'Last Opportunity Activity' },
  { key: 'lastTaskActivity', label: 'Last Task Activity' },
  { key: 'dateLeft', label: 'Date Left' },
  { key: 'contactTags', label: 'Contact Tags' }
  ,{ key: 'vehicleModel', label: 'Vehicle' }
];

const CUSTOMER_IMPORT_HEADER_MAP: Record<string, keyof CustomerImportRow> = {
  business: 'business',
  company: 'business',
  accountmanager: 'accountManager',
  creator: 'creator',
  userloggedin: 'creator',
  createdby: 'creator',
  createdbyuser: 'creator',
  position: 'position',
  title: 'title',
  firstname: 'firstName',
  lastname: 'lastName',
  fullname: 'name',
  name: 'name',
  customername: 'name',
  notes: 'notes',
  tags: 'tags',
  vehicle: 'vehicleModel',
  vehicletag: 'vehicleModel',
  customertag: 'vehicleModel',
  telephone: 'phone',
  phone: 'phone',
  phonenumber: 'phone',
  mobile: 'mobile',
  mobilenumber: 'mobile',
  email: 'email',
  emailaddress: 'email',
  address: 'address',
  address1: 'address1',
  address2: 'address2',
  address3: 'address3',
  city: 'town',
  town: 'town',
  countystateprovince: 'county',
  county: 'county',
  state: 'state',
  postcode: 'postcode',
  zipcode: 'postcode',
  zip: 'postcode',
  country: 'country',
  accountreference: 'accountReference',
  pricelist: 'priceList',
  paymentterm: 'paymentTerm',
  lastquoteactivity: 'lastQuoteActivity',
  lastjobactivity: 'lastJobActivity',
  lastinvoiceactivity: 'lastInvoiceActivity',
  lastopportunityactivity: 'lastOpportunityActivity',
  lasttaskactivity: 'lastTaskActivity',
  dateleft: 'dateLeft',
  contacttags: 'contactTags'
};

@Component({
  selector: 'app-admin-settings',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonContent,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonCheckbox,
    IonItem,
    IonLabel,
    IonInput,
    IonButton,
    IonIcon,
    IonSelect,
    IonSelectOption,
    IonToggle,
    IonTextarea,
    IonBadge,
    UserMenuComponent,
    PageBackButtonComponent,
    CompanySwitcherComponent
  ],
  templateUrl: './admin-settings.component.html',
  styleUrls: ['./admin-settings.component.scss']
})
export default class AdminSettingsComponent implements OnInit, OnDestroy {
  readonly branding = inject(BrandSettingsService);
  readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient);
  private readonly brandingApi = inject(BrandingApi);
  private readonly smsApi = inject(SmsApiService);
  private readonly emailApi = inject(EmailApiService);
  private readonly inventoryApi = inject(InventoryApiService);
  private readonly settingsApi = inject(AppSettingsApiService);
  private readonly businessProfile = inject(BusinessProfileService);
  private readonly addressLookup = inject(AddressLookupService);
  private readonly tenantContext = inject(TenantContextService);
  private readonly route = inject(ActivatedRoute);
  private readonly customersApi = inject(CustomersApi);
  private readonly accessAdminApi = inject(AccessAdminApiService);
  readonly paymentGatewaySettings = inject(PaymentGatewaySettingsService);

  readonly users = signal<WorkspaceUser[]>(this.cloneDefaultUsers());
  readonly integrations = signal<AppIntegration[]>(this.cloneDefaultIntegrations());
  readonly supplierConnectors = signal<InventoryConnector[]>([]);
  readonly supplierLoading = signal(false);
  readonly supplierSaving = signal(false);
  readonly activeSection = signal<AdminSectionKey>('branding');
  readonly sections: AdminSection[] = [
    {
      key: 'branding',
      label: 'Business Profile',
      description: 'Business logo, address, phone, etc.',
      icon: 'image-outline'
    },
    {
      key: 'payments',
      label: 'Payment Gateways',
      description: 'Connect sandbox/live providers for invoice payments',
      icon: 'card-outline'
    },
    {
      key: 'subscription',
      label: 'Subscription',
      description: 'Billing, trial, and plan activation',
      icon: 'card-outline'
    },
    {
      key: 'users',
      label: 'User Access',
      description: 'Roles and team member management',
      icon: 'shield-checkmark-outline'
    },
    {
      key: 'customerImport',
      label: 'Data Imports',
      description: 'Import customers, inventory, and more',
      icon: 'cloud-upload-outline'
    },
    {
      key: 'schedule',
      label: 'Schedule',
      description: 'Business hours, weekends, and calendar bays',
      icon: 'settings-outline'
    },
    {
      key: 'sms',
      label: 'SMS Messaging',
      description: 'Azure ACS mode and test sending',
      icon: 'chatbubble-ellipses-outline'
    },
    {
      key: 'widget',
      label: 'Web Widget',
      description: 'Embed code + lead submit testing',
      icon: 'code-slash-outline'
    },
    {
      key: 'email',
      label: 'Email Templates',
      description: 'Reusable templates for customer email',
      icon: 'mail-outline'
    },
    {
      key: 'integrations',
      label: 'Connected Apps',
      description: 'Core and supplier connector status',
      icon: 'settings-outline'
    }
  ];

  readonly userCount = computed(() => this.users().length);
  readonly logoUrl = computed(() => this.branding.logoUrl());
  readonly hasCustomLogo = computed(() => this.branding.hasCustomLogo());
  readonly widgetTenantId = computed(() => this.tenantContext.tenantId());
  readonly openHourOptions = Array.from({ length: 24 }, (_, hour) => ({
    value: hour,
    label: this.formatHourLabel(hour)
  }));
  readonly closeHourOptions = Array.from({ length: 24 }, (_, index) => {
    const value = index + 1;
    return {
      value,
      label: this.formatHourLabel(value % 24)
    };
  });

  newUserName = '';
  newUserEmail = '';
  newUserRole: 'admin' | 'user' = 'user';
  statusMessage = '';
  usersError = '';
  readonly usersLoading = signal(false);
  passwordStatus = '';
  passwordError = '';
  passwordCurrent = '';
  passwordNext = '';
  passwordConfirm = '';
  readonly passwordSaving = signal(false);
  brandingStatus = '';
  brandingError = '';
  businessProfileStatus = '';
  businessProfileError = '';
  businessProfileName = '';
  businessProfileEmail = '';
  businessProfilePhone = '';
  businessProfileAddress = '';
  businessTaxRate = 0;
  laborRates: LaborRate[] = [];
  documentTemplates: DocumentTemplate[] = [];
  templateInventoryQuery = '';
  readonly inventoryItems = signal<InventoryItem[]>([]);
  businessAddressSuggestions = signal<AddressSuggestion[]>([]);
  businessAddressSearching = signal(false);
  businessAddressNoMatches = signal(false);
  private businessAddressLookupSub: Subscription | null = null;
  private businessAddressSearchTimer: ReturnType<typeof setTimeout> | null = null;
  subscriptionStatus = '';
  subscriptionError = '';
  readonly subscriptionSaving = signal(false);
  subscriptionCardholderName = '';
  subscriptionCardNumber = '';
  subscriptionExpiryMonth = '';
  subscriptionExpiryYear = '';
  subscriptionCvc = '';
  subscriptionPostalCode = '';
  subscriptionPlanCycle: 'monthly' | 'annual' = 'monthly';
  smsTo = '';
  smsMessage = 'Pathflow test: your service update notifications are connected.';
  smsStatus = '';
  smsError = '';
  readonly smsConfig = signal<SmsConfigResponse | null>(null);
  readonly smsLoading = signal(false);
  readonly smsSending = signal(false);
  readonly smsSenderSaving = signal(false);
  smsSenderFrom = '';
  smsSenderLabel = '';
  smsSenderVerification = 'pending';
  readonly emailConfig = signal<EmailConfigResponse | null>(null);
  readonly emailSender = signal<EmailSenderConfig | null>(null);
  readonly emailTemplates = signal<EmailTemplate[]>([]);
  readonly emailLoading = signal(false);
  readonly emailSaving = signal(false);
  emailStatus = '';
  emailError = '';
  emailTemplateId: string | null = null;
  emailTemplateName = '';
  emailTemplateSubject = '';
  emailTemplateBody = '';
  emailSignatureDraft = '';
  quoteTermsDraft = '';
  emailSenderFrom = '';
  emailSenderName = '';
  emailSenderReplyTo = '';
  inboundFrom = '';
  inboundFromName = '';
  inboundSubject = '';
  inboundMessage = '';
  widgetApiUrl = '';
  widgetApiKey = '';
  widgetSource = 'website-widget';
  widgetConsentVersion = 'v1';
  widgetConsentText = 'By checking this box, you agree to receive SMS updates about your appointment, vehicle status, service notifications, billing alerts, and support. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.';
  widgetPrivacyPolicyUrl = 'https://pathflow.com/privacy';
  widgetTermsUrl = 'https://pathflow.com/terms';
  widgetSubmitButtonLabel = 'Send Request';
  widgetSuccessMessage = 'Thanks! Your request was sent.';
  widgetStatus = '';
  widgetError = '';
  readonly widgetSubmitting = signal(false);
  readonly widgetTestResult = signal<WidgetLeadResponse | null>(null);
  widgetTestFirstName = '';
  widgetTestLastName = '';
  widgetTestEmail = '';
  widgetTestPhone = '';
  widgetTestVin = '';
  widgetTestMessage = 'Test lead submit from Admin widget panel.';
  widgetTestSmsOptIn = true;
  supplierStatus = '';
  supplierError = '';
  paymentGatewayStatus = '';
  paymentGatewayError = '';
  authorizeNetApiLoginId = '';
  authorizeNetTransactionKey = '';
  scheduleStatus = '';
  scheduleError = '';
  scheduleOpenHour = 7;
  scheduleCloseHour = 16;
  scheduleShowWeekends = false;
  scheduleBays: Bay[] = [];
  private scheduleSettingsLoaded = false;
  private adminSettingsLoaded = false;
  readonly customerImporting = signal(false);
  readonly customerImportPreviewPage = signal(1);
  readonly customerImportPreviewPageSize = 5;
  readonly customerImportResult = signal<CustomerImportResponse | null>(null);
  readonly customerImportTargetFields = CUSTOMER_IMPORT_TARGET_FIELDS;
  readonly customerImportExpectedHeaders = [...ZIGAFLOW_EXPECTED_HEADERS];
  selectedImportType: 'customers' | 'inventory' = 'customers';
  customerImportFileName = '';
  customerImportHeaders: string[] = [];
  customerImportRows: Array<Record<string, string>> = [];
  customerImportMappings: Array<{ source: string; target: keyof CustomerImportRow | '' }> = [];
  customerImportStatus = '';
  customerImportError = '';
  readonly paymentGatewayDraft = signal<
    Record<PaymentGatewayProviderKey, { accountLabel: string; mode: 'test' | 'live' }>
  >({
    'authorize-net': { accountLabel: '', mode: 'test' },
    stripe: { accountLabel: '', mode: 'test' },
    paypal: { accountLabel: '', mode: 'test' },
    quickbooks: { accountLabel: '', mode: 'test' }
  });

  private readonly businessProfileSync = effect(() => {
    const profile = this.businessProfile.profile();
    this.businessProfileName = String(profile.companyName || '').trim();
    this.businessProfileEmail = String(profile.companyEmail || '').trim();
    this.businessProfilePhone = String(profile.companyPhone || '').trim();
    this.businessProfileAddress = String(profile.companyAddress || '').trim();
  });
  private readonly paymentGatewaySync = effect(() => {
    const providers = this.paymentGatewaySettings.providers();
    const next: Record<PaymentGatewayProviderKey, { accountLabel: string; mode: 'test' | 'live' }> = {
      'authorize-net': { accountLabel: '', mode: 'test' },
      stripe: { accountLabel: '', mode: 'test' },
      paypal: { accountLabel: '', mode: 'test' },
      quickbooks: { accountLabel: '', mode: 'test' }
    };
    for (const provider of providers) {
      next[provider.key] = {
        accountLabel: provider.accountLabel || '',
        mode: provider.mode === 'live' ? 'live' : 'test'
      };
    }
    this.paymentGatewayDraft.set(next);
  });

  constructor() {
    addIcons({
      'shield-checkmark-outline': shieldCheckmarkOutline,
      'settings-outline': settingsOutline,
      'link-outline': linkOutline,
      'add-outline': addOutline,
      'remove-circle-outline': removeCircleOutline,
      'image-outline': imageOutline,
      'cloud-upload-outline': cloudUploadOutline,
      'refresh-outline': refreshOutline,
      'chatbubble-ellipses-outline': chatbubbleEllipsesOutline,
      'send-outline': sendOutline,
      'mail-outline': mailOutline,
      'trash-outline': trashOutline,
      'save-outline': saveOutline,
      'code-slash-outline': codeSlashOutline,
      'copy-outline': copyOutline,
      'card-outline': cardOutline
    });

    this.widgetApiUrl = this.resolveWidgetApiEndpoint(this.widgetApiUrl);
  }

  ngOnInit(): void {
    const sectionParam = (this.route.snapshot.queryParamMap.get('section') || '').trim();
    const matchingSection = this.sections.find(section => section.key === sectionParam);
    if (matchingSection) {
      this.setActiveSection(matchingSection.key);
    }
    this.loadPersistedAdminSettings();
    this.loadSubscriptionState();
    this.loadSmsConfig();
    this.loadEmailAdminData();
    this.loadSupplierConnections();
    this.loadWorkspaceUsers();
    this.loadQuoteTerms();
    this.loadBusinessTaxRate();
    this.loadLaborRates();
    this.loadInventoryItems();
    this.loadDocumentTemplates();
  }

  ngOnDestroy(): void {
    this.businessAddressLookupSub?.unsubscribe();
    if (this.businessAddressSearchTimer) {
      clearTimeout(this.businessAddressSearchTimer);
      this.businessAddressSearchTimer = null;
    }
  }

  saveBusinessProfile(): void {
    this.businessProfileStatus = '';
    this.businessProfileError = '';
    const normalizedTaxRate = this.normalizeTaxRate(this.businessTaxRate);
    forkJoin({
      profile: this.businessProfile.save({
        companyName: this.businessProfileName,
        companyEmail: this.businessProfileEmail,
        companyPhone: this.businessProfilePhone,
        companyAddress: this.businessProfileAddress
      }),
      taxRate: this.settingsApi.setValue<number>(BUSINESS_TAX_RATE_SETTING_KEY, normalizedTaxRate),
      laborRates: this.settingsApi.setValue<LaborRate[]>(
        BUSINESS_LABOR_RATES_SETTING_KEY,
        this.laborRates
          .map(rate => ({
            id: String(rate.id || '').trim() || `labor-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            name: String(rate.name || '').trim(),
            price: this.roundCurrency(Math.max(0, Number(rate.price) || 0)),
            taxable: !!rate.taxable
          }))
          .filter(rate => !!rate.name)
      ),
      documentTemplates: this.settingsApi.setValue<DocumentTemplate[]>(
        BUSINESS_DOCUMENT_TEMPLATES_SETTING_KEY,
        this.normalizeDocumentTemplates(this.documentTemplates)
      )
    }).subscribe({
      next: () => {
        this.businessTaxRate = normalizedTaxRate;
        this.businessProfileStatus = 'Business profile saved.';
        this.businessProfileError = '';
      },
      error: err => {
        this.businessProfileStatus = '';
        this.businessProfileError = this.extractApiError(err, 'Could not save business profile.');
      }
    });
  }

  addLaborRate(): void {
    this.laborRates = [
      ...this.laborRates,
      {
        id: `labor-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name: '',
        price: 0,
        taxable: false
      }
    ];
  }

  removeLaborRate(id: string): void {
    const key = String(id || '').trim();
    if (!key) return;
    this.laborRates = this.laborRates.filter(rate => rate.id !== key);
    this.documentTemplates = this.documentTemplates.map(template => ({
      ...template,
      laborRateIds: template.laborRateIds.filter(rateId => rateId !== key)
    }));
  }

  setTemplateInventoryQuery(value: string | null | undefined): void {
    this.templateInventoryQuery = String(value || '');
  }

  filteredInventoryForTemplates(): InventoryItem[] {
    const query = this.templateInventoryQuery.trim().toLowerCase();
    const items = this.inventoryItems();
    if (!query) return items.slice(0, 60);
    return items
      .filter(item => [item.name, item.sku, item.vendor, item.category].join(' ').toLowerCase().includes(query))
      .slice(0, 60);
  }

  addDocumentTemplate(): void {
    this.documentTemplates = [
      ...this.documentTemplates,
      {
        id: `tmpl-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name: '',
        documentType: 'quote',
        subject: 'Quote for {{customer_name}}',
        body: '<p>Hi {{customer_name}},</p><p>Here is your quote for {{vehicle_summary}}.</p>',
        partItemIds: [],
        laborRateIds: []
      }
    ];
  }

  removeDocumentTemplate(id: string): void {
    const key = String(id || '').trim();
    if (!key) return;
    this.documentTemplates = this.documentTemplates.filter(template => template.id !== key);
  }

  toggleTemplatePart(templateId: string, partId: string, checked: boolean): void {
    this.documentTemplates = this.documentTemplates.map(template => {
      if (template.id !== templateId) return template;
      const next = new Set(template.partItemIds);
      if (checked) next.add(partId);
      else next.delete(partId);
      return { ...template, partItemIds: Array.from(next) };
    });
  }

  toggleTemplateLabor(templateId: string, laborRateId: string, checked: boolean): void {
    this.documentTemplates = this.documentTemplates.map(template => {
      if (template.id !== templateId) return template;
      const next = new Set(template.laborRateIds);
      if (checked) next.add(laborRateId);
      else next.delete(laborRateId);
      return { ...template, laborRateIds: Array.from(next) };
    });
  }

  isPartSelected(template: DocumentTemplate, partId: string): boolean {
    return template.partItemIds.includes(String(partId || '').trim());
  }

  isLaborSelected(template: DocumentTemplate, laborRateId: string): boolean {
    return template.laborRateIds.includes(String(laborRateId || '').trim());
  }

  trackDocumentTemplate(_index: number, template: DocumentTemplate): string {
    return template.id;
  }

  trackInventoryItem(_index: number, item: InventoryItem): string {
    return String(item.id || '').trim() || String(item.sku || '').trim() || item.name;
  }

  trackLaborRate(_index: number, rate: LaborRate): string {
    return String(rate.id || '').trim() || rate.name;
  }

  onBusinessAddressChange(value: string | null | undefined): void {
    this.businessProfileAddress = String(value || '');
    this.businessAddressNoMatches.set(false);
    this.queueBusinessAddressLookup(this.businessProfileAddress);
  }

  onBusinessAddressBlur(): void {
    const normalized = this.businessProfileAddress.trim().toLowerCase();
    if (normalized) {
      const exact = this.businessAddressSuggestions().find(item => item.display.trim().toLowerCase() === normalized);
      if (exact) this.selectBusinessAddressSuggestion(exact);
    }
    setTimeout(() => this.businessAddressSuggestions.set([]), 120);
  }

  selectBusinessAddressSuggestion(item: AddressSuggestion): void {
    this.businessProfileAddress = item.display;
    this.businessAddressSuggestions.set([]);
    this.businessAddressNoMatches.set(false);
  }

  private queueBusinessAddressLookup(raw: string): void {
    if (this.businessAddressSearchTimer) {
      clearTimeout(this.businessAddressSearchTimer);
      this.businessAddressSearchTimer = null;
    }
    this.businessAddressLookupSub?.unsubscribe();
    this.businessAddressSearching.set(false);

    const query = String(raw || '').trim();
    if (query.length < 4) {
      this.businessAddressSuggestions.set([]);
      this.businessAddressNoMatches.set(false);
      return;
    }
    this.businessAddressSearchTimer = setTimeout(() => this.lookupBusinessAddressSuggestions(query), 320);
  }

  private lookupBusinessAddressSuggestions(query: string): void {
    this.businessAddressSearching.set(true);
    this.businessAddressNoMatches.set(false);
    this.businessAddressLookupSub = this.addressLookup.search(query, 6, 'us')
      .pipe(finalize(() => this.businessAddressSearching.set(false)))
      .subscribe({
        next: suggestions => {
          this.businessAddressSuggestions.set(suggestions);
          this.businessAddressNoMatches.set(query.length >= 4 && !suggestions.length);
        },
        error: () => {
          this.businessAddressSuggestions.set([]);
          this.businessAddressNoMatches.set(true);
        }
      });
  }

  addUser(): void {
    const email = this.newUserEmail.trim().toLowerCase();
    const name = this.newUserName.trim();
    if (!name || !email) {
      this.statusMessage = 'Name and email are required.';
      return;
    }
    this.usersError = '';
    this.accessAdminApi
      .inviteUser({
        name,
        email,
        role: this.newUserRole,
        tenantId: this.tenantContext.tenantId()
      })
      .subscribe({
        next: res => {
          this.users.set(Array.isArray(res.items) ? res.items : []);
          this.newUserName = '';
          this.newUserEmail = '';
          this.newUserRole = 'user';
          this.statusMessage = `Invite sent to ${email}.`;
        },
        error: err => {
          this.usersError = this.extractApiError(err, 'Could not invite user.');
        }
      });
  }

  removeUser(user: WorkspaceUser): void {
    this.usersError = '';
    this.accessAdminApi
      .removeUserAccess({
        email: user.email,
        tenantId: this.tenantContext.tenantId()
      })
      .subscribe({
        next: res => {
          this.users.set(Array.isArray(res.items) ? res.items : []);
          this.statusMessage = `${user.email} access removed.`;
        },
        error: err => {
          this.usersError = this.extractApiError(err, 'Could not remove user access.');
        }
      });
  }

  deleteUser(user: WorkspaceUser): void {
    this.usersError = '';
    const email = String(user?.email || '').trim().toLowerCase();
    if (!email) {
      this.usersError = 'User email is required to delete this user.';
      return;
    }
    const confirmed = window.confirm(
      `Delete ${email} from Pathflow completely?\n\nThis permanently removes their user record from the app.`
    );
    if (!confirmed) return;

    this.accessAdminApi
      .deleteUser({
        email,
        tenantId: this.tenantContext.tenantId()
      })
      .subscribe({
        next: res => {
          this.users.set(Array.isArray(res.items) ? res.items : []);
          this.statusMessage = `${email} deleted from Pathflow.`;
        },
        error: err => {
          this.usersError = this.extractApiError(err, 'Could not delete user.');
        }
      });
  }

  resetUserPassword(user: WorkspaceUser): void {
    this.usersError = '';
    this.accessAdminApi
      .resetUserPassword({
        email: user.email,
        tenantId: this.tenantContext.tenantId()
      })
      .subscribe({
        next: res => {
          this.statusMessage = res.message || `Password reset email sent to ${user.email}.`;
        },
        error: err => {
          this.usersError = this.extractApiError(err, 'Could not send password reset email.');
        }
      });
  }

  canChangePassword(): boolean {
    return this.passwordNext.trim().length >= 8 &&
      this.passwordConfirm.trim().length >= 8 &&
      this.passwordNext.trim() === this.passwordConfirm.trim();
  }

  saveMyPasswordChange(): void {
    this.passwordStatus = '';
    this.passwordError = '';
    if (!this.canChangePassword()) {
      this.passwordError = 'Passwords must match and be at least 8 characters.';
      return;
    }
    this.passwordSaving.set(true);
    this.accessAdminApi
      .changeMyPassword({ newPassword: this.passwordNext.trim() })
      .pipe(finalize(() => this.passwordSaving.set(false)))
      .subscribe({
        next: res => {
          this.passwordCurrent = '';
          this.passwordNext = '';
          this.passwordConfirm = '';
          this.passwordStatus = res.message || 'Password reset email sent.';
        },
        error: err => {
          this.passwordError = this.extractApiError(err, 'Could not start password change flow.');
        }
      });
  }

  setActiveSection(section: AdminSectionKey): void {
    this.activeSection.set(section);
    if (section === 'payments') {
      void this.paymentGatewaySettings.load();
      this.loadAuthorizeNetCredentials();
    }
    if (section === 'subscription') {
      this.loadSubscriptionState();
    }
    if (section === 'users') {
      this.loadWorkspaceUsers();
    }
  }

  paymentGatewayDraftFor(key: PaymentGatewayProviderKey): { accountLabel: string; mode: 'test' | 'live' } {
    return this.paymentGatewayDraft()[key] || { accountLabel: '', mode: 'test' };
  }

  updatePaymentGatewayDraftAccount(key: PaymentGatewayProviderKey, value: string): void {
    this.paymentGatewayDraft.update(current => ({
      ...current,
      [key]: {
        ...this.paymentGatewayDraftFor(key),
        accountLabel: String(value || '')
      }
    }));
  }

  updatePaymentGatewayDraftMode(key: PaymentGatewayProviderKey, value: string): void {
    this.paymentGatewayDraft.update(current => ({
      ...current,
      [key]: {
        ...this.paymentGatewayDraftFor(key),
        mode: value === 'live' ? 'live' : 'test'
      }
    }));
  }

  async togglePaymentGatewayConnection(key: PaymentGatewayProviderKey, connected: boolean): Promise<void> {
    this.paymentGatewayStatus = '';
    this.paymentGatewayError = '';
    const draft = this.paymentGatewayDraftFor(key);
    try {
      const currentDefault = this.paymentGatewaySettings.defaultProvider();
      await this.paymentGatewaySettings.setConnection(key, connected, {
        accountLabel: draft.accountLabel,
        mode: draft.mode,
        setAsDefault: connected && !currentDefault
      });
      this.paymentGatewayStatus = connected
        ? 'Payment gateway connected.'
        : 'Payment gateway disconnected.';
    } catch {
      this.paymentGatewayError = 'Could not update payment gateway connection.';
    }
  }

  async savePaymentGatewayProvider(key: PaymentGatewayProviderKey): Promise<void> {
    this.paymentGatewayStatus = '';
    this.paymentGatewayError = '';
    const draft = this.paymentGatewayDraftFor(key);
    try {
      await this.paymentGatewaySettings.updateProvider(key, {
        accountLabel: draft.accountLabel,
        mode: draft.mode
      });
      this.paymentGatewayStatus = 'Payment gateway settings saved.';
    } catch {
      this.paymentGatewayError = 'Could not save payment gateway settings.';
    }
  }

  async setDefaultPaymentGateway(key: PaymentGatewayProviderKey): Promise<void> {
    this.paymentGatewayStatus = '';
    this.paymentGatewayError = '';
    try {
      await this.paymentGatewaySettings.setDefaultProvider(key);
      this.paymentGatewayStatus = 'Default payment gateway updated.';
    } catch {
      this.paymentGatewayError = 'Could not set default payment gateway.';
    }
  }

  saveAuthorizeNetCredentials(): void {
    this.paymentGatewayStatus = '';
    this.paymentGatewayError = '';
    const payload = {
      apiLoginId: String(this.authorizeNetApiLoginId || '').trim(),
      transactionKey: String(this.authorizeNetTransactionKey || '').trim()
    };
    this.settingsApi
      .setValue(AUTHORIZE_NET_CREDENTIALS_SETTING_KEY, payload)
      .subscribe({
        next: () => {
          this.paymentGatewayStatus = 'Authorize.net credentials saved.';
        },
        error: err => {
          this.paymentGatewayError = this.extractApiError(err, 'Could not save Authorize.net credentials.');
        }
      });
  }

  private loadAuthorizeNetCredentials(): void {
    this.settingsApi
      .getValue<{ apiLoginId?: string; transactionKey?: string }>(AUTHORIZE_NET_CREDENTIALS_SETTING_KEY)
      .subscribe({
        next: value => {
          this.authorizeNetApiLoginId = String(value?.apiLoginId || '').trim();
          this.authorizeNetTransactionKey = String(value?.transactionKey || '').trim();
        }
      });
  }

  private loadWorkspaceUsers(): void {
    this.usersLoading.set(true);
    this.usersError = '';
    this.accessAdminApi
      .listUsers(this.tenantContext.tenantId())
      .pipe(finalize(() => this.usersLoading.set(false)))
      .subscribe({
        next: res => {
          this.users.set(Array.isArray(res.items) ? res.items : []);
        },
        error: err => {
          this.usersError = this.extractApiError(err, 'Could not load workspace users.');
          this.users.set(this.cloneDefaultUsers());
        }
      });
  }

  isSubscriptionFormValid(): boolean {
    const cardholder = this.subscriptionCardholderName.trim();
    const cardNumber = this.digitsOnly(this.subscriptionCardNumber);
    const monthDigits = this.digitsOnly(this.subscriptionExpiryMonth);
    const yearDigits = this.digitsOnly(this.subscriptionExpiryYear);
    const cvcDigits = this.digitsOnly(this.subscriptionCvc);
    const postalDigits = this.digitsOnly(this.subscriptionPostalCode);

    if (/^9{5,}$/.test(cardNumber)) return true;

    if (cardholder.length < 2) return false;
    if (cardNumber.length < 13 || cardNumber.length > 19) return false;
    if (monthDigits.length < 1 || monthDigits.length > 2) return false;
    if (yearDigits.length < 2 || yearDigits.length > 4) return false;
    if (cvcDigits.length < 3 || cvcDigits.length > 4) return false;
    if (postalDigits.length < 5) return false;

    const month = Number(monthDigits);
    if (!Number.isFinite(month) || month < 1 || month > 12) return false;

    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().getMonth() + 1;
    const parsedYear = yearDigits.length === 2 ? Number(`20${yearDigits}`) : Number(yearDigits);
    if (!Number.isFinite(parsedYear) || parsedYear < currentYear || parsedYear > currentYear + 25) return false;
    if (parsedYear === currentYear && month < currentMonth) return false;

    return true;
  }

  async saveSubscription(): Promise<void> {
    if (!this.isSubscriptionFormValid()) {
      this.subscriptionError = 'Enter valid billing details.';
      this.subscriptionStatus = '';
      return;
    }

    this.subscriptionSaving.set(true);
    this.subscriptionStatus = '';
    this.subscriptionError = '';
    try {
      const response = await this.auth.updateBilling(
        {
          cardholderName: this.subscriptionCardholderName.trim(),
          cardNumber: this.digitsOnly(this.subscriptionCardNumber),
          expiryMonth: this.digitsOnly(this.subscriptionExpiryMonth),
          expiryYear: this.digitsOnly(this.subscriptionExpiryYear),
          cvc: this.digitsOnly(this.subscriptionCvc),
          postalCode: this.digitsOnly(this.subscriptionPostalCode),
          sandboxBypass: /^9{5,}$/.test(this.digitsOnly(this.subscriptionCardNumber))
        },
        this.subscriptionPlanCycle
      );
      if (!response.ok) {
        this.subscriptionError = response.error || 'Could not update subscription.';
        return;
      }
      this.subscriptionStatus = 'Subscription updated and workspace activated.';
      this.loadSubscriptionState();
    } finally {
      this.subscriptionSaving.set(false);
    }
  }

  private loadSubscriptionState(): void {
    this.subscriptionPlanCycle = this.auth.planCycle() === 'annual' ? 'annual' : 'monthly';
    this.subscriptionStatus = '';
    this.subscriptionError = '';
  }

  private digitsOnly(value: unknown): string {
    return String(value ?? '').replace(/\D+/g, '');
  }

  async onCustomerImportFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.customerImportError = '';
    this.customerImportStatus = '';
    this.customerImportResult.set(null);

    try {
      const workbook = XLSX.read(await file.arrayBuffer(), {
        type: 'array',
        cellDates: true
      });
      const firstSheetName = workbook.SheetNames?.[0];
      const sheet = firstSheetName ? workbook.Sheets[firstSheetName] : null;
      if (!sheet) {
        this.customerImportError = 'No worksheet found in this file.';
        return;
      }

      const headerMatrix = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
        header: 1,
        raw: false,
        blankrows: false
      });
      const rawHeaders = (headerMatrix[0] || [])
        .map(value => String(value ?? '').trim())
        .filter(Boolean);
      if (!rawHeaders.length) {
        this.customerImportError = 'No header row found. Include a header row in row 1.';
        return;
      }

      const records = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        raw: false,
        defval: '',
        blankrows: false
      });
      const rows = records.map(record => {
        const mapped: Record<string, string> = {};
        for (const header of rawHeaders) {
          mapped[header] = String(record[header] ?? '').trim();
        }
        return mapped;
      });

      this.customerImportFileName = file.name;
      this.customerImportHeaders = rawHeaders;
      this.customerImportRows = rows;
      this.customerImportPreviewPage.set(1);
      this.customerImportMappings = rawHeaders.map(source => ({
        source,
        target: this.autoMapCustomerImportHeader(source)
      }));
      this.customerImportStatus = `Loaded ${rows.length} row(s) from ${file.name}.`;
    } catch {
      this.customerImportError = 'Could not read this file. Use a valid CSV or Excel file.';
    }
  }

  mappedCustomerImportCount(): number {
    return this.customerImportMappings.filter(item => !!item.target).length;
  }

  customerImportPreviewRows(): Array<Record<string, string>> {
    const page = Math.max(1, Math.min(this.customerImportPreviewPage(), this.customerImportPreviewTotalPages()));
    const start = (page - 1) * this.customerImportPreviewPageSize;
    return this.customerImportRows.slice(start, start + this.customerImportPreviewPageSize);
  }

  customerImportPreviewTotalPages(): number {
    return Math.max(1, Math.ceil(this.customerImportRows.length / this.customerImportPreviewPageSize));
  }

  prevCustomerImportPreviewPage(): void {
    this.customerImportPreviewPage.update(value => Math.max(1, value - 1));
  }

  nextCustomerImportPreviewPage(): void {
    this.customerImportPreviewPage.update(value => Math.min(this.customerImportPreviewTotalPages(), value + 1));
  }

  missingExpectedImportHeaders(): string[] {
    if (!this.customerImportHeaders.length) return [];
    const existing = new Set(this.customerImportHeaders.map(header => this.normalizeImportHeader(header)));
    return this.customerImportExpectedHeaders.filter(
      expected => !existing.has(this.normalizeImportHeader(expected))
    );
  }

  canRunCustomerImport(): boolean {
    if (this.customerImporting()) return false;
    if (!this.customerImportRows.length) return false;
    const hasIdentityField = this.customerImportMappings.some(item =>
      item.target === 'email' ||
      item.target === 'phone' ||
      item.target === 'mobile' ||
      item.target === 'name' ||
      item.target === 'firstName' ||
      item.target === 'lastName'
    );
    return hasIdentityField;
  }

  importCustomersFromFile(): void {
    if (!this.canRunCustomerImport()) {
      this.customerImportError =
        'Map at least one identity column (email, phone/mobile, name or first/last name) before importing.';
      return;
    }

    const rows = this.buildMappedCustomerImportRows();
    if (!rows.length) {
      this.customerImportError = 'No non-empty rows found after mapping.';
      return;
    }

    this.customerImporting.set(true);
    this.customerImportError = '';
    this.customerImportStatus = '';
    this.customerImportResult.set(null);

    this.customersApi
      .importRows(rows)
      .pipe(finalize(() => this.customerImporting.set(false)))
      .subscribe({
        next: result => {
          this.customerImportResult.set(result);
          this.customerImportStatus =
            `Import finished. Created ${result.created}, updated ${result.updated}, ` +
            `skipped ${result.skipped}${result.errors.length ? `, errors ${result.errors.length}` : ''}.`;
        },
        error: err => {
          const message = this.extractApiError(err, 'Customer import failed.');
          if (message.toLowerCase().includes('name required')) {
            this.customerImportError =
              'Customer import failed. The API received this as a single-customer request instead of an import batch. Please retry (we now send smaller batches).';
            return;
          }
          this.customerImportError = message;
        }
      });
  }

  private buildMappedCustomerImportRows(): CustomerImportRow[] {
    const activeMappings = this.customerImportMappings.filter(item => !!item.target) as Array<{
      source: string;
      target: keyof CustomerImportRow;
    }>;

    return this.customerImportRows
      .map(sourceRow => {
        const out: CustomerImportRow = {};
        for (const mapping of activeMappings) {
          const value = String(sourceRow[mapping.source] ?? '').trim();
          if (!value) continue;
          out[mapping.target] = value as never;
        }

        if (!out.name) {
          const firstName = String(out.firstName || '').trim();
          const lastName = String(out.lastName || '').trim();
          const full = `${firstName} ${lastName}`.trim();
          if (full) out.name = full;
        }

        return out;
      })
      .filter(row => Object.keys(row).length > 0);
  }

  private autoMapCustomerImportHeader(header: string): keyof CustomerImportRow | '' {
    return CUSTOMER_IMPORT_HEADER_MAP[this.normalizeImportHeader(header)] || '';
  }

  private normalizeImportHeader(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  toggleIntegration(key: string): void {
    if (key === 'acs-sms') {
      this.statusMessage = 'Azure SMS connection is managed in the SMS Messaging panel.';
      this.loadSmsConfig();
      return;
    }
    if (key === 'sendgrid-email') {
      this.statusMessage = 'Email connection is managed in the Email Messaging panel.';
      this.loadEmailAdminData();
      return;
    }

    this.integrations.update(list =>
      list.map(integration =>
        integration.key === key
          ? { ...integration, connected: !integration.connected }
          : integration
      )
    );

    this.persistIntegrations();
    this.statusMessage = 'Integration connection state updated.';
  }

  loadSupplierConnections(): void {
    this.supplierLoading.set(true);
    this.supplierError = '';
    this.inventoryApi
      .getState()
      .pipe(finalize(() => this.supplierLoading.set(false)))
      .subscribe({
        next: res => {
          this.supplierConnectors.set(Array.isArray(res.connectors) ? res.connectors : []);
        },
        error: err => {
          this.supplierError = this.extractApiError(err, 'Could not load supplier connections.');
        }
      });
  }

  connectorBadgeLabel(connector: InventoryConnector): string {
    if (connector.status === 'connected') return 'connected';
    if (connector.status === 'error') return 'error';
    if (connector.status === 'not-connected') return 'not connected';
    if (connector.status === 'partner-only') return 'partner only';
    return 'planned';
  }

  connectorBadgeColor(connector: InventoryConnector): 'success' | 'danger' | 'medium' | 'warning' | 'primary' {
    if (connector.status === 'connected') return 'success';
    if (connector.status === 'error') return 'danger';
    if (connector.status === 'not-connected') return 'medium';
    if (connector.status === 'partner-only') return 'warning';
    return 'primary';
  }

  connectorActionLabel(connector: InventoryConnector): string {
    if (connector.id === 'nexpart') return 'Check connection';
    if (connector.status === 'not-connected') return 'Connect';
    if (connector.status === 'partner-only') return 'Request access';
    if (connector.status === 'connected') return 'Connected';
    return 'Planned';
  }

  connectorActionDisabled(connector: InventoryConnector): boolean {
    if (connector.id === 'nexpart') return false;
    return connector.status === 'planned' || connector.status === 'connected';
  }

  connectSupplierConnector(connector: InventoryConnector): void {
    this.supplierSaving.set(true);
    this.supplierError = '';
    this.supplierStatus = '';

    if (connector.id === 'nexpart') {
      this.inventoryApi
        .nexpartPing()
        .pipe(finalize(() => this.supplierSaving.set(false)))
        .subscribe({
          next: res => {
            this.supplierStatus = res.connected
              ? 'Nexpart connection check succeeded.'
              : 'Nexpart connection check failed.';
            this.loadSupplierConnections();
          },
          error: err => {
            this.supplierError = this.extractApiError(err, 'Nexpart connection check failed.');
            this.loadSupplierConnections();
          }
        });
      return;
    }

    this.inventoryApi
      .upsertConnector({
        id: connector.id,
        provider: connector.provider,
        segment: connector.segment,
        status: connector.status,
        note: connector.note,
        enabled: true
      })
      .pipe(finalize(() => this.supplierSaving.set(false)))
      .subscribe({
        next: () => {
          this.supplierStatus = `${connector.provider} connector updated.`;
          this.loadSupplierConnections();
        },
        error: err => {
          this.supplierError = this.extractApiError(err, 'Could not update supplier connection.');
        }
      });
  }

  trackSupplierConnector(_index: number, connector: InventoryConnector): string {
    return connector.id;
  }

  onLogoFileSelected(event: Event): void {
    this.brandingError = '';
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.brandingStatus = '';
      this.brandingError = 'Please select a valid image file.';
      input.value = '';
      return;
    }

    const maxBytes = 5 * 1024 * 1024;
    if (file.size > maxBytes) {
      this.brandingStatus = '';
      this.brandingError = 'Logo must be 5MB or smaller.';
      input.value = '';
      return;
    }

    this.brandingStatus = 'Uploading logo...';
    this.brandingError = '';
    void this.uploadLogoViaApi(file, input);
  }

  private async uploadLogoViaApi(file: File, input: HTMLInputElement): Promise<void> {
    try {
      const fileDataUrl = await this.readFileAsDataUrl(file);
      const result = await firstValueFrom(
        this.brandingApi.uploadLogo(file.name, file.type || 'application/octet-stream', fileDataUrl)
      );
      this.branding.setLogoUrl(result.url);
      this.brandingStatus = 'Business logo updated.';
      this.brandingError = '';
    } catch {
      this.brandingStatus = '';
      this.brandingError = 'Logo upload failed. Try again.';
    } finally {
      input.value = '';
    }
  }

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('Unable to read file.'));
      reader.readAsDataURL(file);
    });
  }

  resetBusinessLogo(): void {
    this.brandingError = '';
    const currentUrl = (this.logoUrl() || '').trim();
    const defaultUrl = (this.branding.defaultLogoUrl || '').trim();
    if (!currentUrl || currentUrl === defaultUrl) {
      this.branding.resetLogo();
      this.brandingStatus = 'Business logo reset to default.';
      return;
    }

    this.brandingStatus = 'Removing uploaded logo...';
    this.brandingApi.deleteLogo(currentUrl).subscribe({
      next: () => {
        this.branding.resetLogo();
        this.brandingStatus = 'Business logo removed. You can upload a new logo now.';
        this.brandingError = '';
      },
      error: () => {
        this.brandingStatus = '';
        this.brandingError = 'Could not remove logo file. Please try again.';
      }
    });
  }

  loadSmsConfig(): void {
    this.smsLoading.set(true);
    this.smsError = '';
    this.smsApi
      .getConfig()
      .pipe(finalize(() => this.smsLoading.set(false)))
      .subscribe({
        next: config => {
          this.smsConfig.set(config);
          this.applySmsConnectionToIntegration(config);
          this.smsSenderFrom = (config.sender?.fromNumber || config.fromNumber || '').trim();
          this.smsSenderLabel = (config.sender?.label || '').trim();
          this.smsSenderVerification = (config.sender?.verificationStatus || 'pending').trim() || 'pending';
          if (config.mode === 'mock') {
            this.smsStatus = 'SMS is in mock mode (free local testing, no texts sent to carriers).';
            return;
          }

          this.smsStatus = config.readyForLive
            ? `Azure SMS ready to send from ${config.fromNumber ?? '(configured number)'}.`
            : 'Azure mode is enabled but not fully configured yet.';
        },
        error: err => {
          this.smsError = this.extractApiError(err, 'Could not load SMS configuration.');
        }
      });
  }

  sendTestSms(): void {
    const to = this.smsTo.trim();
    const message = this.smsMessage.trim();
    this.smsError = '';

    if (!to) {
      this.smsError = 'Enter a phone number in E.164 format (example: +15551234567).';
      return;
    }

    if (!message) {
      this.smsError = 'Message cannot be empty.';
      return;
    }

    this.smsSending.set(true);
    this.smsApi
      .sendTest(to, message)
      .pipe(finalize(() => this.smsSending.set(false)))
      .subscribe({
        next: res => {
          this.smsStatus = res.simulated
            ? `Mock SMS accepted for ${res.to}. No carrier send was attempted.`
            : `SMS sent to ${res.to}${res.messageId ? ` (message ID: ${res.messageId})` : ''}.`;
        },
        error: err => {
          this.smsError = this.extractApiError(err, 'SMS send failed.');
        }
      });
  }

  canSaveSmsSender(): boolean {
    return /^\+[1-9]\d{7,14}$/.test(this.smsSenderFrom.trim());
  }

  saveSmsSenderConfig(): void {
    const fromNumber = this.smsSenderFrom.trim();
    if (!/^\+[1-9]\d{7,14}$/.test(fromNumber)) {
      this.smsError = 'Sender number must be valid E.164 format (example: +15551234567).';
      return;
    }

    this.smsSenderSaving.set(true);
    this.smsError = '';
    this.smsStatus = '';
    this.smsApi
      .setSenderConfig({
        fromNumber,
        label: this.smsSenderLabel.trim() || undefined,
        verificationStatus: this.smsSenderVerification.trim() || undefined
      })
      .pipe(finalize(() => this.smsSenderSaving.set(false)))
      .subscribe({
        next: () => {
          this.smsStatus = 'Tenant SMS sender saved.';
          this.loadSmsConfig();
        },
        error: err => {
          this.smsError = this.extractApiError(err, 'Could not save tenant SMS sender.');
        }
      });
  }

  resetSmsSenderConfig(): void {
    this.smsSenderSaving.set(true);
    this.smsError = '';
    this.smsStatus = '';
    this.smsApi
      .clearSenderConfig()
      .pipe(finalize(() => this.smsSenderSaving.set(false)))
      .subscribe({
        next: () => {
          this.smsStatus = 'Tenant SMS sender reset to environment default.';
          this.loadSmsConfig();
        },
        error: err => {
          this.smsError = this.extractApiError(err, 'Could not reset tenant SMS sender.');
        }
      });
  }

  canSubmitWidgetTest(): boolean {
    if (this.widgetSubmitting()) return false;
    const firstName = this.widgetTestFirstName.trim();
    const lastName = this.widgetTestLastName.trim();
    const email = this.widgetTestEmail.trim();
    const phone = this.widgetTestPhone.trim();
    const phoneE164 = this.normalizeWidgetPhone(phone);
    const vin = this.widgetTestVin.trim().toUpperCase();
    if (!firstName || !lastName) return false;
    if (!email && !phone) return false;
    if (phone && !phoneE164) return false;
    if (!this.isValidVin(vin)) return false;
    if (phone && !this.widgetTestSmsOptIn) return false;
    return true;
  }

  async copyWidgetEmbedCode(): Promise<void> {
    this.widgetError = '';
    const copied = await this.copyText(this.widgetEmbedCode());
    this.widgetStatus = copied
      ? 'Widget embed code copied to clipboard.'
      : '';
    if (!copied) {
      this.widgetError = 'Could not copy embed code. Copy from the text box below.';
    }
  }

  async copyWidgetApiUrl(): Promise<void> {
    this.widgetError = '';
    const endpoint = this.resolveWidgetApiEndpoint(this.widgetApiUrl);
    this.widgetApiUrl = endpoint;
    const copied = await this.copyText(endpoint);
    this.widgetStatus = copied
      ? 'Widget API URL copied.'
      : '';
    if (!copied) {
      this.widgetError = 'Could not copy API URL.';
    }
  }

  submitWidgetTest(): void {
    const endpoint = this.resolveWidgetApiEndpoint(this.widgetApiUrl);
    this.widgetApiUrl = endpoint;
    const firstName = this.widgetTestFirstName.trim();
    const lastName = this.widgetTestLastName.trim();
    const name = `${firstName} ${lastName}`.trim();
    const email = this.widgetTestEmail.trim();
    const phoneRaw = this.widgetTestPhone.trim();
    const phone = this.normalizeWidgetPhone(phoneRaw);
    const vin = this.widgetTestVin.trim().toUpperCase();
    const message = this.widgetTestMessage.trim();
    const smsOptIn = !!this.widgetTestSmsOptIn;
    const tenantId = this.widgetTenantId();

    this.widgetStatus = '';
    this.widgetError = '';
    this.widgetTestResult.set(null);

    if (!firstName || !lastName) {
      this.widgetError = 'First and last name are required.';
      return;
    }
    if (!email && !phoneRaw) {
      this.widgetError = 'At least email or phone is required.';
      return;
    }
    if (phoneRaw && !phone) {
      this.widgetError = 'Phone must be valid E.164 format (example: +15551234567) or a 10-digit US number.';
      return;
    }
    if (!vin) {
      this.widgetError = 'VIN is required.';
      return;
    }
    if (!this.isValidVin(vin)) {
      this.widgetError = 'VIN must be 17 characters and cannot include I, O, or Q.';
      return;
    }
    if (phone && !smsOptIn) {
      this.widgetError = 'Enable SMS opt-in when sending a test with phone number.';
      return;
    }

    const payload = {
      source: this.widgetSource.trim() || 'website-widget',
      firstName,
      lastName,
      name,
      email,
      phone,
      vin,
      message,
      smsOptIn,
      tenantId,
      consentMethod: 'web-checkbox',
      smsConsentVersion: this.widgetConsentVersion.trim() || 'v1',
      smsConsentText: this.widgetConsentTextWithPolicyLinks(),
      optInPageUrl: typeof window !== 'undefined' ? window.location.href : ''
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const key = this.widgetApiKey.trim();
    if (key) headers['x-widget-key'] = key;
    if (tenantId) headers['x-tenant-id'] = tenantId;

    this.widgetSubmitting.set(true);
    this.http
      .post<WidgetLeadResponse>(endpoint, payload, { headers })
      .pipe(finalize(() => this.widgetSubmitting.set(false)))
      .subscribe({
        next: response => {
          this.widgetTestResult.set(response);
          const customerText = response.customerCreated
            ? 'Customer created.'
            : 'Matched existing customer.';
          const leadText = response.leadCreated
            ? 'Lead card created in Leads.'
            : 'Existing lead was updated.';
          const smsText = response.sms?.confirmationSent
            ? 'Opt-in SMS confirmation sent.'
            : (response.sms?.confirmationAttempted
              ? 'Opt-in SMS confirmation attempted.'
              : 'No opt-in SMS confirmation was sent.');
          this.widgetStatus = `${customerText} ${leadText} ${smsText}`;
        },
        error: err => {
          this.widgetError = this.extractApiError(err, 'Could not submit widget test.');
        }
      });
  }

  widgetEmbedCode(): string {
    return this.buildWidgetEmbedCode();
  }

  loadEmailAdminData(): void {
    this.emailLoading.set(true);
    this.emailError = '';
    forkJoin({
      config: this.emailApi.getConfig(),
      sender: this.emailApi.getSenderConfig().pipe(catchError(() => of(null))),
      templates: this.emailApi.listTemplates()
    })
      .pipe(finalize(() => this.emailLoading.set(false)))
      .subscribe({
        next: ({ config, sender, templates }) => {
          this.emailConfig.set(config);
          this.emailSender.set(sender?.sender || null);
          this.emailSenderFrom = (sender?.sender?.fromEmail || config?.fromEmail || '').trim();
          this.emailSenderName = (sender?.sender?.fromName || '').trim();
          this.emailSenderReplyTo = (sender?.sender?.replyTo || '').trim();
          this.applyEmailConnectionToIntegration(config);
          this.applyEmailTemplatesResponse(templates, true);
          this.emailStatus = '';
        },
        error: err => {
          this.emailError = this.extractApiError(err, 'Could not load Email configuration.');
        }
      });
  }

  canSaveEmailSender(): boolean {
    return this.isValidEmail(this.emailSenderFrom.trim());
  }

  saveEmailSender(): void {
    const fromEmail = this.emailSenderFrom.trim();
    const fromName = this.emailSenderName.trim();
    const replyTo = this.emailSenderReplyTo.trim();
    if (!this.isValidEmail(fromEmail)) {
      this.emailError = 'Sender email must be a valid address.';
      return;
    }
    if (replyTo && !this.isValidEmail(replyTo)) {
      this.emailError = 'Reply-to must be a valid email address.';
      return;
    }

    this.emailSaving.set(true);
    this.emailError = '';
    this.emailStatus = '';
    this.emailApi.setSenderConfig({
      fromEmail,
      fromName: fromName || undefined,
      replyTo: replyTo || undefined
    })
      .pipe(finalize(() => this.emailSaving.set(false)))
      .subscribe({
        next: res => {
          const sender = res?.sender || null;
          this.emailSender.set(sender);
          this.emailSenderFrom = (sender?.fromEmail || '').trim();
          this.emailSenderName = (sender?.fromName || '').trim();
          this.emailSenderReplyTo = (sender?.replyTo || '').trim();
          this.emailStatus = 'Email sender saved.';
        },
        error: err => {
          this.emailError = this.extractApiError(err, 'Could not save email sender.');
        }
      });
  }

  resetEmailSender(): void {
    this.emailSaving.set(true);
    this.emailError = '';
    this.emailStatus = '';
    this.emailApi.clearSenderConfig()
      .pipe(finalize(() => this.emailSaving.set(false)))
      .subscribe({
        next: res => {
          const sender = res?.sender || null;
          this.emailSender.set(sender);
          this.emailSenderFrom = (sender?.fromEmail || '').trim();
          this.emailSenderName = (sender?.fromName || '').trim();
          this.emailSenderReplyTo = (sender?.replyTo || '').trim();
          this.emailStatus = 'Email sender reset to environment default.';
        },
        error: err => {
          this.emailError = this.extractApiError(err, 'Could not reset email sender.');
        }
      });
  }

  clearEmailTemplateForm(): void {
    this.emailTemplateId = null;
    this.emailTemplateName = '';
    this.emailTemplateSubject = '';
    this.emailTemplateBody = '';
    this.emailError = '';
  }

  editEmailTemplate(template: EmailTemplate): void {
    this.emailTemplateId = template.id;
    this.emailTemplateName = template.name;
    this.emailTemplateSubject = template.subject;
    this.emailTemplateBody = template.body;
    this.emailError = '';
  }

  canSaveEmailTemplate(): boolean {
    return !!this.emailTemplateName.trim() && !!this.emailTemplateSubject.trim() && !!this.emailTemplateBody.trim();
  }

  canInsertTemplateLogo(): boolean {
    const logo = String(this.logoUrl() || '').trim();
    return this.hasCustomLogo() && !!logo;
  }

  insertSavedLogoIntoTemplate(): void {
    const logo = this.toEmailAssetUrl(String(this.logoUrl() || '').trim());
    if (!this.canInsertTemplateLogo() || !logo) {
      this.emailError = 'Upload a business logo first in Branding before inserting it into a template.';
      return;
    }
    this.emailError = '';
    const imgTag = `<img src="${logo}" alt="Company logo" style="max-width:220px;height:auto;display:block;" />`;
    const current = String(this.emailTemplateBody || '').trim();
    this.emailTemplateBody = current ? `${current}\n\n${imgTag}` : imgTag;
  }

  emailTemplatePreviewHtml(): string {
    const html = String(this.emailTemplateBody || '').trim();
    if (!html) return '';
    return this.resolveEmailMergeTags(html, this.previewMergeTagValues());
  }

  emailSignaturePreviewHtml(): string {
    const signature = String(this.emailSignatureDraft || '').trim();
    if (!signature) return '';
    const resolved = this.resolveEmailMergeTags(signature, this.previewMergeTagValues());
    if (/<[^>]+>/.test(resolved)) return resolved;
    return this.escapeHtml(resolved).replace(/\n/g, '<br/>');
  }

  saveEmailTemplate(): void {
    const name = this.emailTemplateName.trim();
    const subject = this.emailTemplateSubject.trim();
    const body = this.emailTemplateBody.trim();
    if (!name || !subject || !body) {
      this.emailError = 'Template name, subject, and body are required.';
      return;
    }

    const editingId = this.emailTemplateId;
    this.emailSaving.set(true);
    this.emailError = '';
    this.emailStatus = '';
    this.emailApi
      .upsertTemplate({
        id: editingId || undefined,
        name,
        subject,
        body
      })
      .pipe(finalize(() => this.emailSaving.set(false)))
      .subscribe({
        next: res => {
          this.applyEmailTemplatesResponse(res, false);
          const savedId = res.id || editingId;
          const saved = savedId
            ? this.emailTemplates().find(item => item.id === savedId) || null
            : null;
          if (saved) {
            this.editEmailTemplate(saved);
          } else {
            this.clearEmailTemplateForm();
          }
          this.emailStatus = editingId ? 'Template updated.' : 'Template created.';
        },
        error: err => {
          this.emailError = this.extractApiError(err, 'Could not save email template.');
        }
      });
  }

  deleteEmailTemplate(template: EmailTemplate): void {
    const templateId = template?.id || '';
    if (!templateId) return;
    const confirmed = window.confirm(`Delete email template "${template.name}"?`);
    if (!confirmed) return;

    this.emailSaving.set(true);
    this.emailError = '';
    this.emailStatus = '';
    this.emailApi
      .deleteTemplate(templateId)
      .pipe(finalize(() => this.emailSaving.set(false)))
      .subscribe({
        next: res => {
          this.applyEmailTemplatesResponse(res, false);
          if (this.emailTemplateId === templateId) {
            this.clearEmailTemplateForm();
          }
          this.emailStatus = 'Template deleted.';
        },
        error: err => {
          this.emailError = this.extractApiError(err, 'Could not delete email template.');
        }
      });
  }

  saveEmailSignature(): void {
    this.emailSaving.set(true);
    this.emailError = '';
    this.emailStatus = '';
    this.emailApi
      .setSignature(this.emailSignatureDraft.trim())
      .pipe(finalize(() => this.emailSaving.set(false)))
      .subscribe({
        next: res => {
          this.applyEmailTemplatesResponse(res, true);
          this.emailStatus = 'Default signature saved.';
        },
        error: err => {
          this.emailError = this.extractApiError(err, 'Could not save signature.');
        }
      });
  }

  quoteTermsPreviewHtml(): string {
    const terms = String(this.quoteTermsDraft || '').trim();
    if (!terms) return '';
    if (/<[^>]+>/.test(terms)) return this.resolveEmailMergeTags(terms, this.previewMergeTagValues());
    return this.escapeHtml(terms).replace(/\n/g, '<br/>');
  }

  saveQuoteTerms(): void {
    this.emailSaving.set(true);
    this.emailError = '';
    this.emailStatus = '';
    this.settingsApi
      .setValue<string>(EMAIL_FOOTER_TERMS_SETTING_KEY, this.quoteTermsDraft.trim())
      .pipe(finalize(() => this.emailSaving.set(false)))
      .subscribe({
        next: () => {
          this.emailStatus = 'Default email footer terms saved.';
        },
        error: err => {
          this.emailError = this.extractApiError(err, 'Could not save email footer terms.');
        }
      });
  }

  canLogInboundEmail(): boolean {
    return this.isValidEmail(this.inboundFrom) && !!this.inboundSubject.trim() && !!this.inboundMessage.trim();
  }

  logInboundEmail(): void {
    const from = this.inboundFrom.trim();
    const subject = this.inboundSubject.trim();
    const message = this.inboundMessage.trim();
    if (!this.isValidEmail(from)) {
      this.emailError = 'Inbound sender email must be valid.';
      return;
    }
    if (!subject || !message) {
      this.emailError = 'Inbound subject and message are required.';
      return;
    }

    this.emailSaving.set(true);
    this.emailError = '';
    this.emailStatus = '';
    this.emailApi
      .logIncoming({
        from,
        fromName: this.inboundFromName.trim() || undefined,
        subject,
        message
      })
      .pipe(finalize(() => this.emailSaving.set(false)))
      .subscribe({
        next: res => {
          const customerText = res.customerCreated
            ? 'New customer created from sender email.'
            : 'Matched to an existing customer.';
          const leadText = res.leadCreated
            ? 'Lead card created in Leads.'
            : 'No new lead card was created.';
          this.emailStatus = `${customerText} ${leadText}`;
          this.inboundSubject = '';
          this.inboundMessage = '';
        },
        error: err => {
          this.emailError = this.extractApiError(err, 'Could not log inbound email.');
        }
      });
  }

  private buildWidgetEmbedCode(): string {
    const apiUrl = this.resolveWidgetApiEndpoint(this.widgetApiUrl);
    const tenantId = this.widgetTenantId();
    const apiKey = this.widgetApiKey.trim();
    const source = (this.widgetSource || 'website-widget').trim();
    const consentVersion = (this.widgetConsentVersion || 'v1').trim();
    const consentText = this.widgetConsentTextWithPolicyLinks();
    const successMessage = (this.widgetSuccessMessage || 'Thanks! Your request was sent.').trim();
    const submitLabel = (this.widgetSubmitButtonLabel || 'Send Request').trim();

    const escapedConsentHtml = this.escapeHtml(consentText);
    const escapedSubmitHtml = this.escapeHtml(submitLabel);
    const lines = [
      '<div id="pathflow-lead-widget"></div>',
      '<script>',
      '(function () {',
      "  const root = document.getElementById('pathflow-lead-widget');",
      '  if (!root) return;',
      `  const apiUrl = '${this.escapeJsString(apiUrl)}';`,
      `  const tenantId = '${this.escapeJsString(tenantId)}';`,
      `  const apiKey = '${this.escapeJsString(apiKey)}';`,
      `  const source = '${this.escapeJsString(source)}';`,
      `  const consentVersion = '${this.escapeJsString(consentVersion)}';`,
      `  const consentText = '${this.escapeJsString(consentText)}';`,
      `  const successMessage = '${this.escapeJsString(successMessage)}';`,
      "  root.innerHTML = [",
      "    '<form id=\"pathflowLeadForm\" style=\"display:grid;gap:10px;max-width:460px;font-family:Arial,sans-serif\">',",
      "    '  <input name=\"firstName\" type=\"text\" placeholder=\"First name\" required style=\"padding:10px;border:1px solid #cbd5e1;border-radius:8px;\">',",
      "    '  <input name=\"lastName\" type=\"text\" placeholder=\"Last name\" required style=\"padding:10px;border:1px solid #cbd5e1;border-radius:8px;\">',",
      "    '  <input name=\"email\" type=\"email\" placeholder=\"Email\" style=\"padding:10px;border:1px solid #cbd5e1;border-radius:8px;\">',",
      "    '  <input name=\"phone\" type=\"tel\" placeholder=\"Phone\" style=\"padding:10px;border:1px solid #cbd5e1;border-radius:8px;\">',",
      "    '  <input name=\"vin\" type=\"text\" required minlength=\"17\" maxlength=\"17\" pattern=\"[A-HJ-NPR-Z0-9]{17}\" placeholder=\"VIN (17 chars)\" style=\"padding:10px;border:1px solid #cbd5e1;border-radius:8px;\">',",
      "    '  <textarea name=\"message\" rows=\"4\" placeholder=\"How can we help?\" style=\"padding:10px;border:1px solid #cbd5e1;border-radius:8px;\"></textarea>',",
      "    '  <label style=\"font-size:13px;line-height:1.4;color:#334155;\">',",
      `    '    <input name="smsOptIn" type="checkbox" value="true" style="margin-right:6px;vertical-align:middle;">${escapedConsentHtml}',`,
      "    '  </label>',",
      `    '  <button type="submit" style="padding:10px 14px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer;">${escapedSubmitHtml}</button>',`,
      "    '  <div id=\"pathflowLeadStatus\" style=\"font-size:13px;min-height:18px;\"></div>',",
      "    '</form>'",
      "  ].join('');",
      "  const form = document.getElementById('pathflowLeadForm');",
      "  const status = document.getElementById('pathflowLeadStatus');",
      '  if (!form || !status) return;',
      "  form.addEventListener('submit', async function (event) {",
      '    event.preventDefault();',
      "    status.textContent = 'Sending...';",
      "    status.style.color = '#64748b';",
      '    const formData = new FormData(form);',
      '    const payload = {',
      '      source: source,',
      "      firstName: String(formData.get('firstName') || '').trim(),",
      "      lastName: String(formData.get('lastName') || '').trim(),",
      "      name: '',",
      "      email: String(formData.get('email') || '').trim(),",
      "      phone: String(formData.get('phone') || '').trim(),",
      "      vin: String(formData.get('vin') || '').trim().toUpperCase().replace(/\\s+/g, ''),",
      "      message: String(formData.get('message') || '').trim(),",
      "      smsOptIn: !!formData.get('smsOptIn'),",
      "      tenantId: tenantId,",
      "      consentMethod: 'web-checkbox',",
      '      smsConsentVersion: consentVersion,',
      '      smsConsentText: consentText,',
      '      optInPageUrl: window.location.href',
      '    };',
      "    payload.name = (payload.firstName + ' ' + payload.lastName).trim();",
      '    if (!payload.firstName || !payload.lastName) {',
      "      status.textContent = 'First and last name are required.';",
      "      status.style.color = '#dc2626';",
      '      return;',
      '    }',
      '    if (!payload.vin) {',
      "      status.textContent = 'VIN is required.';",
      "      status.style.color = '#dc2626';",
      '      return;',
      '    }',
      "    if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(payload.vin)) {",
      "      status.textContent = 'VIN must be 17 characters and cannot include I, O, or Q.';",
      "      status.style.color = '#dc2626';",
      '      return;',
      '    }',
      '    if (!payload.email && !payload.phone) {',
      "      status.textContent = 'Email or phone is required.';",
      "      status.style.color = '#dc2626';",
      '      return;',
      '    }',
      '    if (payload.phone && !payload.smsOptIn) {',
      "      status.textContent = 'SMS opt-in is required when phone is provided.';",
      "      status.style.color = '#dc2626';",
      '      return;',
      '    }',
      "    const headers = { 'Content-Type': 'application/json' };",
      "    if (apiKey) headers['x-widget-key'] = apiKey;",
      "    if (tenantId) headers['x-tenant-id'] = tenantId;",
      '    try {',
      '      const response = await fetch(apiUrl, {',
      "        method: 'POST',",
      '        headers: headers,',
      '        body: JSON.stringify(payload)',
      '      });',
      '      const data = await response.json().catch(function () { return {}; });',
      "      if (!response.ok || !data.ok) throw new Error(data.error || 'Lead submit failed.');",
      '      status.textContent = successMessage;',
      "      status.style.color = '#16a34a';",
      '      form.reset();',
      '    } catch (error) {',
      "      status.textContent = (error && error.message) ? error.message : 'Could not submit lead.';",
      "      status.style.color = '#dc2626';",
      '    }',
      '  });',
      '})();',
      '</script>'
    ];

    return lines.join('\n');
  }

  private resolveWidgetApiEndpoint(rawValue: string): string {
    const raw = String(rawValue || '').trim();
    const localProxyEndpoint = this.localProxyWidgetEndpoint();
    if (raw) {
      if (raw === '/api') return localProxyEndpoint || `${this.resolvePublicAppOrigin()}/api/widget/lead`;
      if (raw.startsWith('/api/')) return localProxyEndpoint || `${this.resolvePublicAppOrigin()}${raw}`;
      try {
        const parsed = new URL(raw);
        if (!this.isLoopbackHost(parsed.hostname)) {
          const canonicalOrigin = this.canonicalWidgetOrigin(parsed.origin);
          const path = (parsed.pathname || '').replace(/\/+$/, '');
          if (!path || path === '/') return `${canonicalOrigin}/api/widget/lead`;
          if (path === '/api') return `${canonicalOrigin}/api/widget/lead`;
          if (path.startsWith('/api/')) return `${canonicalOrigin}${path}`;
          return `${canonicalOrigin}/api/widget/lead`;
        }
      } catch {
        // Ignore malformed input and fall back to the configured public endpoint.
      }
    }
    if (localProxyEndpoint) return localProxyEndpoint;
    return `${this.resolvePublicAppOrigin()}/api/widget/lead`;
  }

  private resolvePublicAppOrigin(): string {
    if (typeof window !== 'undefined') {
      const browserOrigin = this.normalizePublicOrigin(window.location.origin || '');
      if (browserOrigin) return this.canonicalWidgetOrigin(browserOrigin);
    }

    const configured = this.normalizePublicOrigin(environment.publicAppUrl || environment.apiBase || '');
    if (configured) return this.canonicalWidgetOrigin(configured);

    return 'https://www.pathflow-app.com';
  }

  private normalizePublicOrigin(value: string): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      if (this.isLoopbackHost(parsed.hostname)) return '';
      return parsed.origin;
    } catch {
      return '';
    }
  }

  private isLoopbackHost(hostname: string): boolean {
    const host = String(hostname || '').trim().toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  }

  private canonicalWidgetOrigin(origin: string): string {
    const normalized = String(origin || '').trim();
    if (!normalized) return normalized;
    try {
      const parsed = new URL(normalized);
      const host = String(parsed.hostname || '').toLowerCase();
      if (host === 'wonderful-glacier-0f45f5110.6.azurestaticapps.net') {
        return 'https://www.pathflow-app.com';
      }
      return parsed.origin;
    } catch {
      return normalized;
    }
  }

  private localProxyWidgetEndpoint(): string {
    if (typeof window === 'undefined') return '';
    const host = String(window.location.hostname || '').trim().toLowerCase();
    if (this.isLoopbackHost(host)) return '/api/widget/lead';
    return '';
  }

  private widgetConsentTextWithPolicyLinks(): string {
    const base = this.widgetConsentText.trim();
    const privacy = this.widgetPrivacyPolicyUrl.trim();
    const terms = this.widgetTermsUrl.trim();
    const parts: string[] = [];
    if (base) parts.push(base);
    if (privacy) parts.push(`Privacy Policy: ${privacy}`);
    if (terms) parts.push(`Terms: ${terms}`);
    return parts.join(' | ');
  }

  private escapeJsString(value: string): string {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\r/g, '')
      .replace(/\n/g, '\\n');
  }

  private escapeHtml(value: string): string {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private async copyText(value: string): Promise<boolean> {
    const text = String(value || '').trim();
    if (!text) return false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}

    if (typeof document === 'undefined') return false;
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'absolute';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (_) {
      copied = false;
    }
    document.body.removeChild(textArea);
    return copied;
  }

  private isValidVin(value: string): boolean {
    return /^[A-HJ-NPR-Z0-9]{17}$/.test(String(value || '').trim().toUpperCase());
  }

  private normalizeWidgetPhone(value: string): string {
    const digits = String(value || '').replace(/\D+/g, '');
    if (!digits) return '';
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
    return '';
  }

  addScheduleBay(): void {
    const id = `bay-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    this.scheduleBays = [
      ...this.scheduleBays,
      {
        id,
        name: `Bay ${this.scheduleBays.length + 1}`
      }
    ];
    this.scheduleStatus = '';
    this.scheduleError = '';
  }

  removeScheduleBay(id: string): void {
    this.scheduleBays = this.scheduleBays.filter(bay => bay.id !== id);
    this.scheduleStatus = '';
    this.scheduleError = '';
  }

  canSaveScheduleSettings(): boolean {
    return !this.scheduleValidationError();
  }

  saveScheduleSettings(): void {
    const validationError = this.scheduleValidationError();
    if (validationError) {
      this.scheduleError = validationError;
      this.scheduleStatus = '';
      return;
    }

    const openHour = Math.min(23, Math.max(0, Number(this.scheduleOpenHour) || 0));
    let closeHour = Math.min(24, Math.max(1, Number(this.scheduleCloseHour) || 1));
    if (closeHour <= openHour) {
      closeHour = Math.min(24, openHour + 1);
    }

    const current = this.defaultScheduleSettings();
    const settings: ScheduleSettings = {
      ...current,
      openHour,
      closeHour,
      showWeekends: !!this.scheduleShowWeekends,
      bays: this.scheduleBays.map(bay => ({
        id: bay.id,
        name: (bay.name || '').trim() || bay.id
      }))
    };

    this.settingsApi.setValue(SCHEDULE_SETTINGS_KEY, settings).subscribe({
      next: () => {
        this.scheduleStatus = 'Schedule settings saved.';
        this.scheduleError = '';
      },
      error: () => {
        this.scheduleError = 'Could not save schedule settings.';
        this.scheduleStatus = '';
      }
    });
  }

  private cloneDefaultUsers(): WorkspaceUser[] {
    return DEFAULT_ADMIN_USERS.map(item => ({ ...item }));
  }

  private cloneDefaultIntegrations(): AppIntegration[] {
    return DEFAULT_INTEGRATIONS.map(item => ({ ...item }));
  }

  private loadPersistedAdminSettings(): void {
    forkJoin({
      integrations: this.settingsApi.getValue<AppIntegration[]>(ADMIN_INTEGRATIONS_SETTING_KEY),
      schedule: this.settingsApi.getValue<ScheduleSettings>(SCHEDULE_SETTINGS_KEY)
    }).subscribe(({ integrations, schedule }) => {
      this.integrations.set(this.normalizeIntegrations(integrations));
      this.applyScheduleSettings(this.normalizeScheduleSettings(schedule));
      this.adminSettingsLoaded = true;
      this.scheduleSettingsLoaded = true;
    });
  }

  private defaultScheduleSettings(): ScheduleSettings {
    return {
      bays: [
        { id: 'bay-1', name: 'Two-Post Lift 1' },
        { id: 'bay-2', name: 'Two-Post Lift 2' },
        { id: 'bay-3', name: 'Two-Post Lift 3' },
        { id: 'bay-4', name: 'Two-Post Lift 4' },
        { id: 'bay-5', name: 'Four-Post Lift' }
      ],
      openHour: 7,
      closeHour: 16,
      showWeekends: false,
      holidays: [],
      federalYear: new Date().getFullYear(),
      federalInitialized: false
    };
  }

  private normalizeScheduleSettings(value: unknown): ScheduleSettings {
    const parsed = value && typeof value === 'object' ? (value as Partial<ScheduleSettings>) : {};
    const base = this.defaultScheduleSettings();
    const bays = Array.isArray(parsed.bays)
      ? parsed.bays
          .map(item => (item && typeof item === 'object' ? item : null))
          .filter((item): item is Bay => !!item)
          .map((item, index) => {
            const id = String((item as Partial<Bay>).id || '').trim() || `bay-${Date.now()}-${index}`;
            const name = String((item as Partial<Bay>).name || '').trim() || id;
            return { id, name };
          })
      : [];
    return {
      bays: bays.length ? bays : base.bays,
      openHour: Number.isFinite(parsed.openHour) ? Number(parsed.openHour) : base.openHour,
      closeHour: Number.isFinite(parsed.closeHour) ? Number(parsed.closeHour) : base.closeHour,
      showWeekends: typeof parsed.showWeekends === 'boolean' ? parsed.showWeekends : base.showWeekends,
      holidays: Array.isArray(parsed.holidays) ? parsed.holidays.map(v => String(v || '')) : base.holidays,
      federalYear: Number.isFinite(parsed.federalYear) ? Number(parsed.federalYear) : base.federalYear,
      federalInitialized:
        typeof parsed.federalInitialized === 'boolean' ? parsed.federalInitialized : base.federalInitialized
    };
  }

  private applyScheduleSettings(settings: ScheduleSettings): void {
    this.scheduleOpenHour = settings.openHour;
    this.scheduleCloseHour = settings.closeHour;
    this.scheduleShowWeekends = !!settings.showWeekends;
    this.scheduleBays = settings.bays.map(bay => ({ ...bay }));
  }

  private scheduleValidationError(): string {
    const openHour = Math.min(23, Math.max(0, Number(this.scheduleOpenHour) || 0));
    const closeHour = Math.min(24, Math.max(1, Number(this.scheduleCloseHour) || 1));
    if (closeHour <= openHour) {
      return 'Close time must be after open time.';
    }
    if (!this.scheduleBays.length) {
      return 'At least one bay is required.';
    }
    if (this.scheduleBays.some(bay => !(bay.name || '').trim())) {
      return 'Each bay needs a name.';
    }
    return '';
  }

  private formatHourLabel(hour24: number): string {
    const normalized = ((hour24 % 24) + 24) % 24;
    const suffix = normalized >= 12 ? 'PM' : 'AM';
    const hour12 = normalized % 12 || 12;
    return `${hour12}:00 ${suffix}`;
  }

  private normalizeIntegrations(value: unknown): AppIntegration[] {
    const defaults = this.cloneDefaultIntegrations();
    if (!Array.isArray(value)) return defaults;
    const byKey = new Map(defaults.map(item => [item.key, item]));
    for (const row of value) {
      const source = row && typeof row === 'object' ? (row as Partial<AppIntegration>) : null;
      if (!source) continue;
      const key = String(source.key || '').trim();
      const existing = byKey.get(key);
      if (!existing) continue;
      byKey.set(key, {
        ...existing,
        connected: !!source.connected,
        summary: String(source.summary || existing.summary).trim() || existing.summary,
        name: String(source.name || existing.name).trim() || existing.name
      });
    }
    return Array.from(byKey.values());
  }

  private persistIntegrations(): void {
    if (!this.adminSettingsLoaded) return;
    this.settingsApi.setValue(ADMIN_INTEGRATIONS_SETTING_KEY, this.integrations()).subscribe({ error: () => {} });
  }

  private applyEmailConnectionToIntegration(config: EmailConfigResponse): void {
    const connected = config.mode === 'sendgrid' && config.readyForLive;
    this.integrations.update(list =>
      list.map(integration =>
        integration.key === 'sendgrid-email'
          ? { ...integration, connected }
          : integration
      )
    );
  }

  private applyEmailTemplatesResponse(response: EmailTemplatesResponse, syncSignatureDraft: boolean): void {
    this.emailTemplates.set(Array.isArray(response.templates) ? response.templates : []);
    if (syncSignatureDraft) {
      this.emailSignatureDraft = typeof response.signature === 'string' ? response.signature : '';
    }
  }

  private previewMergeTagValues(): Record<string, string> {
    const companyName = this.activeCompanyName();
    const logoUrl = this.toEmailAssetUrl(String(this.logoUrl() || '').trim());
    const profile = this.businessProfile.profile();
    return {
      company_name: companyName,
      company_logo_url: logoUrl,
      company_email: profile.companyEmail || 'service@yourcompany.com',
      company_phone: profile.companyPhone || '(555) 555-0100',
      company_address: profile.companyAddress || '123 Main St, Anytown, USA',
      company_location: profile.companyAddress || '123 Main St, Anytown, USA',
      customer_name: 'Jamie Customer',
      customer_email: 'jamie.customer@example.com',
      customer_phone: '(555) 410-8822',
      lead_message: 'I need a quote for suspension and alignment.',
      quote_terms: String(this.quoteTermsDraft || '').trim()
    };
  }

  private loadQuoteTerms(): void {
    this.settingsApi.getValue<string>(EMAIL_FOOTER_TERMS_SETTING_KEY).subscribe({
      next: value => {
        const primary = String(value || '').trim();
        if (primary) {
          this.quoteTermsDraft = primary;
          return;
        }
        this.settingsApi.getValue<string>(LEGACY_QUOTE_TERMS_SETTING_KEY).subscribe({
          next: legacy => {
            this.quoteTermsDraft = String(legacy || '').trim();
          },
          error: () => {
            this.quoteTermsDraft = '';
          }
        });
      },
      error: () => {
        this.quoteTermsDraft = '';
      }
    });
  }

  private loadBusinessTaxRate(): void {
    this.settingsApi.getValue<number | string>(BUSINESS_TAX_RATE_SETTING_KEY).subscribe({
      next: value => {
        this.businessTaxRate = this.normalizeTaxRate(value);
      },
      error: () => {
        this.businessTaxRate = 0;
      }
    });
  }

  private loadLaborRates(): void {
    this.settingsApi.getValue<LaborRate[]>(BUSINESS_LABOR_RATES_SETTING_KEY)
      .subscribe({
        next: value => {
          const rows = Array.isArray(value) ? value : [];
          this.laborRates = rows
            .map((item, index) => ({
              id: String(item?.id || '').trim() || `labor-${Date.now()}-${index}`,
              name: String(item?.name || '').trim(),
              price: this.roundCurrency(Math.max(0, Number(item?.price) || 0)),
              taxable: !!item?.taxable
            }))
            .filter(item => !!item.name);
        },
        error: () => {
          this.laborRates = [];
        }
      });
  }

  private loadInventoryItems(): void {
    this.inventoryApi.listItems().subscribe({
      next: res => {
        this.inventoryItems.set(Array.isArray(res?.items) ? res.items : []);
      },
      error: () => {
        this.inventoryItems.set([]);
      }
    });
  }

  private loadDocumentTemplates(): void {
    this.settingsApi.getValue<DocumentTemplate[]>(BUSINESS_DOCUMENT_TEMPLATES_SETTING_KEY)
      .subscribe({
        next: value => {
          this.documentTemplates = this.normalizeDocumentTemplates(Array.isArray(value) ? value : []);
        },
        error: () => {
          this.documentTemplates = [];
        }
      });
  }

  private normalizeDocumentTemplates(value: unknown): DocumentTemplate[] {
    const source = Array.isArray(value) ? value : [];
    return source
      .map((item, index) => {
        const row = item && typeof item === 'object' ? (item as Partial<DocumentTemplate>) : null;
        if (!row) return null;
        const id = String(row.id || '').trim() || `tmpl-${Date.now()}-${index}`;
        const name = String(row.name || '').trim();
        const documentTypeRaw = String(row.documentType || '').trim().toLowerCase();
        const documentType: DocumentTemplateType =
          documentTypeRaw === 'invoice'
            ? 'invoice'
            : documentTypeRaw === 'both'
              ? 'both'
              : 'quote';
        const subject = String(row.subject || '').trim() || 'Quote for {{customer_name}}';
        const body = String(row.body || '').trim() || '<p>Hi {{customer_name}},</p><p>Here is your quote for {{vehicle_summary}}.</p>';
        const partItemIds = Array.isArray(row.partItemIds)
          ? row.partItemIds.map(idValue => String(idValue || '').trim()).filter(Boolean)
          : [];
        const laborRateIds = Array.isArray(row.laborRateIds)
          ? row.laborRateIds.map(idValue => String(idValue || '').trim()).filter(Boolean)
          : [];

        if (!name) return null;
        return { id, name, documentType, subject, body, partItemIds, laborRateIds };
      })
      .filter((item): item is DocumentTemplate => !!item);
  }

  private normalizeTaxRate(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    if (numeric < 0) return 0;
    if (numeric > 100) return 100;
    return Math.round((numeric + Number.EPSILON) * 100) / 100;
  }

  private roundCurrency(value: number): number {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
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

  private isValidEmail(value: string): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
  }

  private applySmsConnectionToIntegration(config: SmsConfigResponse): void {
    const connected = config.mode === 'azure' && config.readyForLive;
    this.integrations.update(list =>
      list.map(integration =>
        integration.key === 'acs-sms'
          ? { ...integration, connected }
          : integration
      )
    );
  }

  private extractApiError(err: unknown, fallback: string): string {
    if (err instanceof HttpErrorResponse) {
      const detail = typeof err.error === 'object' && err.error !== null
        ? (err.error.detail || err.error.error || err.message)
        : err.message;
      return `${fallback} ${String(detail)}`.trim();
    }

    return fallback;
  }

}
