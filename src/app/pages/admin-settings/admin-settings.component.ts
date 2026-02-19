import { Component, OnInit, computed, inject, signal } from '@angular/core';
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
  IonTextarea,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';
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
  copyOutline
} from 'ionicons/icons';
import { finalize, forkJoin } from 'rxjs';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { BrandSettingsService } from '../../services/brand-settings.service';
import { BrandingApi } from '../../services/branding-api.service';
import { SmsApiService, SmsConfigResponse } from '../../services/sms-api.service';
import {
  EmailApiService,
  EmailConfigResponse,
  EmailTemplate,
  EmailTemplatesResponse
} from '../../services/email-api.service';
import { InventoryApiService, InventoryConnector } from '../../services/inventory-api.service';
import { AppSettingsApiService } from '../../services/app-settings-api.service';
import { TenantContextService } from '../../services/tenant-context.service';
import { environment } from '../../../environments/environment';

interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  status: 'active' | 'invited';
}

interface AppIntegration {
  key: string;
  name: string;
  connected: boolean;
  summary: string;
}

const ADMIN_USERS_SETTING_KEY = 'admin.users';
const ADMIN_INTEGRATIONS_SETTING_KEY = 'admin.integrations';
const DEFAULT_ADMIN_USERS: AdminUser[] = [
  {
    id: 'u-1',
    name: 'Shop Owner',
    email: 'owner@exodus4x4.com',
    role: 'admin',
    status: 'active'
  },
  {
    id: 'u-2',
    name: 'Service Advisor',
    email: 'advisor@exodus4x4.com',
    role: 'user',
    status: 'active'
  },
  {
    id: 'u-3',
    name: 'Operations Lead',
    email: 'ops@exodus4x4.com',
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

type AdminSectionKey = 'branding' | 'users' | 'sms' | 'widget' | 'email' | 'integrations';

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
    IonTextarea,
    IonBadge,
    UserMenuComponent,
    PageBackButtonComponent
  ],
  templateUrl: './admin-settings.component.html',
  styleUrls: ['./admin-settings.component.scss']
})
export default class AdminSettingsComponent implements OnInit {
  readonly branding = inject(BrandSettingsService);
  private readonly http = inject(HttpClient);
  private readonly brandingApi = inject(BrandingApi);
  private readonly smsApi = inject(SmsApiService);
  private readonly emailApi = inject(EmailApiService);
  private readonly inventoryApi = inject(InventoryApiService);
  private readonly settingsApi = inject(AppSettingsApiService);
  private readonly tenantContext = inject(TenantContextService);

  readonly users = signal<AdminUser[]>(this.cloneDefaultUsers());
  readonly integrations = signal<AppIntegration[]>(this.cloneDefaultIntegrations());
  readonly supplierConnectors = signal<InventoryConnector[]>([]);
  readonly supplierLoading = signal(false);
  readonly supplierSaving = signal(false);
  readonly activeSection = signal<AdminSectionKey>('branding');
  readonly sections: AdminSection[] = [
    {
      key: 'branding',
      label: 'Branding',
      description: 'Business logo and visual identity',
      icon: 'image-outline'
    },
    {
      key: 'users',
      label: 'User Access',
      description: 'Roles and team member management',
      icon: 'shield-checkmark-outline'
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
      label: 'Email + Templates',
      description: 'Templates, signatures, and inbound email',
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
  readonly hasCustomLogo = computed(() => this.logoUrl() !== this.branding.defaultLogoUrl);
  readonly widgetTenantId = computed(() => this.tenantContext.tenantId());

  newUserName = '';
  newUserEmail = '';
  newUserRole: 'admin' | 'user' = 'user';
  statusMessage = '';
  brandingStatus = '';
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
  widgetTestName = 'Website Lead Test';
  widgetTestEmail = '';
  widgetTestPhone = '';
  widgetTestVin = '';
  widgetTestMessage = 'Test lead submit from Admin widget panel.';
  widgetTestSmsOptIn = true;
  supplierStatus = '';
  supplierError = '';
  private adminSettingsLoaded = false;

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
      'copy-outline': copyOutline
    });

    this.widgetApiUrl = this.resolveWidgetApiEndpoint(this.widgetApiUrl);
  }

  ngOnInit(): void {
    this.loadPersistedAdminSettings();
    this.loadSmsConfig();
    this.loadEmailAdminData();
    this.loadSupplierConnections();
  }

  addUser(): void {
    const email = this.newUserEmail.trim().toLowerCase();
    const name = this.newUserName.trim();
    if (!name || !email) {
      this.statusMessage = 'Name and email are required.';
      return;
    }

    if (this.users().some(u => u.email.toLowerCase() === email)) {
      this.statusMessage = 'That email already exists in the list.';
      return;
    }

    const user: AdminUser = {
      id: `u-${Date.now()}`,
      name,
      email,
      role: this.newUserRole,
      status: 'invited'
    };

    this.users.update(list => [...list, user]);
    this.newUserName = '';
    this.newUserEmail = '';
    this.newUserRole = 'user';
    this.persistUsers();
    this.statusMessage = `Invite queued for ${email}.`;
  }

  removeUser(id: string): void {
    this.users.update(list => list.filter(u => u.id !== id));
    this.persistUsers();
    this.statusMessage = 'User removed.';
  }

  setActiveSection(section: AdminSectionKey): void {
    this.activeSection.set(section);
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
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      this.brandingStatus = 'Please select a valid image file.';
      input.value = '';
      return;
    }

    const maxBytes = 5 * 1024 * 1024;
    if (file.size > maxBytes) {
      this.brandingStatus = 'Logo must be 5MB or smaller.';
      input.value = '';
      return;
    }

    this.brandingStatus = 'Uploading logo...';
    this.brandingApi.getUploadSas(file.name, file.type || 'application/octet-stream').subscribe({
      next: async sas => {
        try {
          const response = await fetch(sas.uploadUrl, {
            method: 'PUT',
            headers: {
              'x-ms-blob-type': 'BlockBlob',
              'Content-Type': file.type || 'application/octet-stream'
            },
            body: file
          });
          if (!response.ok) {
            throw new Error(`Upload failed (${response.status})`);
          }
          this.branding.setLogoUrl(sas.url);
          this.brandingStatus = 'Business logo updated.';
        } catch {
          this.brandingStatus = 'Logo upload failed. Try again.';
        } finally {
          input.value = '';
        }
      },
      error: () => {
        this.brandingStatus = 'Could not get upload URL.';
        input.value = '';
      }
    });
  }

  resetBusinessLogo(): void {
    this.branding.resetLogo();
    this.brandingStatus = 'Business logo reset to default.';
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
    const name = this.widgetTestName.trim();
    const email = this.widgetTestEmail.trim();
    const phone = this.widgetTestPhone.trim();
    const vin = this.widgetTestVin.trim().toUpperCase();
    if (!name) return false;
    if (!email && !phone) return false;
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
    const name = this.widgetTestName.trim();
    const email = this.widgetTestEmail.trim();
    const phone = this.widgetTestPhone.trim();
    const vin = this.widgetTestVin.trim().toUpperCase();
    const message = this.widgetTestMessage.trim();
    const smsOptIn = !!this.widgetTestSmsOptIn;
    const tenantId = this.widgetTenantId();

    this.widgetStatus = '';
    this.widgetError = '';
    this.widgetTestResult.set(null);

    if (!name) {
      this.widgetError = 'Name is required.';
      return;
    }
    if (!email && !phone) {
      this.widgetError = 'At least email or phone is required.';
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
      templates: this.emailApi.listTemplates()
    })
      .pipe(finalize(() => this.emailLoading.set(false)))
      .subscribe({
        next: ({ config, templates }) => {
          this.emailConfig.set(config);
          this.applyEmailConnectionToIntegration(config);
          this.applyEmailTemplatesResponse(templates, true);
          if (config.mode === 'mock') {
            this.emailStatus = 'Email is in mock mode (free local testing, no provider send).';
            return;
          }
          this.emailStatus = config.readyForLive
            ? `SendGrid is ready to send from ${config.fromEmail ?? '(configured sender)'}.`
            : 'SendGrid mode is enabled but not fully configured yet.';
        },
        error: err => {
          this.emailError = this.extractApiError(err, 'Could not load Email configuration.');
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
      "    '  <input name=\"name\" type=\"text\" placeholder=\"Full name\" required style=\"padding:10px;border:1px solid #cbd5e1;border-radius:8px;\">',",
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
      "      name: String(formData.get('name') || '').trim(),",
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
    if (raw) {
      if (raw === '/api') return `${this.resolvePublicAppOrigin()}/api/widget/lead`;
      if (raw.startsWith('/api/')) return `${this.resolvePublicAppOrigin()}${raw}`;
      try {
        const parsed = new URL(raw);
        if (!this.isLoopbackHost(parsed.hostname)) {
          const path = (parsed.pathname || '').replace(/\/+$/, '');
          if (!path || path === '/') return `${parsed.origin}/api/widget/lead`;
          if (path === '/api') return `${parsed.origin}/api/widget/lead`;
          if (path.startsWith('/api/')) return `${parsed.origin}${path}`;
          return `${parsed.origin}/api/widget/lead`;
        }
      } catch {
        // Ignore malformed input and fall back to the configured public endpoint.
      }
    }
    return `${this.resolvePublicAppOrigin()}/api/widget/lead`;
  }

  private resolvePublicAppOrigin(): string {
    if (typeof window !== 'undefined') {
      const browserOrigin = this.normalizePublicOrigin(window.location.origin || '');
      if (browserOrigin) return browserOrigin;
    }

    const configured = this.normalizePublicOrigin(environment.publicAppUrl || environment.apiBase || '');
    if (configured) return configured;

    return 'https://app.pathflow.com';
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

  private cloneDefaultUsers(): AdminUser[] {
    return DEFAULT_ADMIN_USERS.map(item => ({ ...item }));
  }

  private cloneDefaultIntegrations(): AppIntegration[] {
    return DEFAULT_INTEGRATIONS.map(item => ({ ...item }));
  }

  private loadPersistedAdminSettings(): void {
    forkJoin({
      users: this.settingsApi.getValue<AdminUser[]>(ADMIN_USERS_SETTING_KEY),
      integrations: this.settingsApi.getValue<AppIntegration[]>(ADMIN_INTEGRATIONS_SETTING_KEY)
    }).subscribe(({ users, integrations }) => {
      this.users.set(this.normalizeUsers(users));
      this.integrations.set(this.normalizeIntegrations(integrations));
      this.adminSettingsLoaded = true;
    });
  }

  private normalizeUsers(value: unknown): AdminUser[] {
    if (!Array.isArray(value)) return this.cloneDefaultUsers();
    const out: AdminUser[] = [];
    for (const row of value) {
      const source = row && typeof row === 'object' ? (row as Partial<AdminUser>) : null;
      if (!source) continue;
      const id = String(source.id || `u-${Date.now()}-${Math.floor(Math.random() * 1000)}`).trim();
      const name = String(source.name || '').trim();
      const email = String(source.email || '').trim().toLowerCase();
      if (!id || !name || !email) continue;
      const role: AdminUser['role'] = source.role === 'admin' ? 'admin' : 'user';
      const status: AdminUser['status'] = source.status === 'active' ? 'active' : 'invited';
      out.push({ id, name, email, role, status });
    }
    return out.length ? out : this.cloneDefaultUsers();
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

  private persistUsers(): void {
    if (!this.adminSettingsLoaded) return;
    this.settingsApi.setValue(ADMIN_USERS_SETTING_KEY, this.users()).subscribe({ error: () => {} });
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
