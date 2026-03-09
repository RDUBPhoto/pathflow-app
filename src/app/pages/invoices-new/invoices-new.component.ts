import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ToastController } from '@ionic/angular';
import { IonButton, IonButtons, IonContent, IonHeader, IonSpinner, IonTitle, IonToolbar } from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../auth/auth.service';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { BrandSettingsService } from '../../services/brand-settings.service';
import { BusinessProfileService } from '../../services/business-profile.service';
import { AppSettingsApiService } from '../../services/app-settings-api.service';
import { Customer, CustomersApi } from '../../services/customers-api.service';
import { EmailApiService, EmailTemplate } from '../../services/email-api.service';
import {
  InvoiceDetail,
  InvoiceLineItem,
  InvoiceLineType,
  InvoiceDocumentType,
  InvoiceDraftPayload,
  InvoicesDataService
} from '../../services/invoices-data.service';
import { InventoryApiService, InventoryItem } from '../../services/inventory-api.service';
import { Lane, LanesApi } from '../../services/lanes-api.service';
import { SmsApiService } from '../../services/sms-api.service';
import { TenantContextService } from '../../services/tenant-context.service';
import { WorkItem, WorkItemsApi } from '../../services/workitems-api.service';
import { environment } from '../../../environments/environment';

type StatusTone = 'neutral' | 'success' | 'error';
type WizardStep = 1 | 2 | 3 | 4 | 5;
const EMAIL_FOOTER_TERMS_SETTING_KEY = 'email.footer.terms.html';
const LEGACY_QUOTE_TERMS_SETTING_KEY = 'quote.terms.html';
const BUSINESS_TAX_RATE_SETTING_KEY = 'business.tax.rate';
const BUSINESS_LABOR_RATES_SETTING_KEY = 'business.labor.rates';
const BUSINESS_DOCUMENT_TEMPLATES_SETTING_KEY = 'business.document.templates';
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

type CustomerPrefill = {
  name: string;
  email: string;
  phone: string;
  vehicle: string;
};

@Component({
  selector: 'app-invoices-new',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonSpinner,
    IonContent,
    PageBackButtonComponent,
    CompanySwitcherComponent,
    UserMenuComponent
  ],
  templateUrl: './invoices-new.component.html',
  styleUrls: ['./invoices-new.component.scss']
})
export default class InvoicesNewComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly customersApi = inject(CustomersApi);
  private readonly lanesApi = inject(LanesApi);
  private readonly workItemsApi = inject(WorkItemsApi);
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly emailApi = inject(EmailApiService);
  private readonly smsApi = inject(SmsApiService);
  private readonly branding = inject(BrandSettingsService);
  private readonly businessProfile = inject(BusinessProfileService);
  private readonly settingsApi = inject(AppSettingsApiService);
  private readonly inventoryApi = inject(InventoryApiService);
  private readonly toastController = inject(ToastController);
  private readonly tenantContext = inject(TenantContextService);

  readonly wizardStep = signal<WizardStep>(1);
  readonly documentType = signal<InvoiceDocumentType>('quote');

  readonly status = signal('');
  readonly statusTone = signal<StatusTone>('neutral');
  readonly loading = signal(false);
  readonly sending = signal(false);

  readonly customerQuery = signal('');
  readonly customers = signal<Customer[]>([]);
  readonly recentLeadCustomers = signal<Customer[]>([]);
  readonly recentLeadsLoading = signal(false);
  readonly selectedCustomer = signal<Customer | null>(null);

  readonly draftId = signal<string | null>(null);
  readonly draftSavedAt = signal<string>('');
  readonly currentDraft = signal<InvoiceDetail | null>(null);

  readonly emailTemplates = signal<EmailTemplate[]>([]);
  readonly documentTemplates = signal<DocumentTemplate[]>([]);
  readonly selectedTemplateId = signal<string>('');
  readonly selectedTemplateSubject = signal('');
  readonly saveManualAsTemplate = signal(false);
  readonly manualTemplateName = signal('');
  readonly manualTemplateSubject = signal('Quote for {{customer_name}}');
  readonly manualTemplateBody = signal('');
  readonly creatingTemplate = signal(false);
  readonly emailSignature = signal('');
  readonly includeLogo = signal(true);
  readonly includeSignature = signal(true);
  readonly quoteTerms = signal('');
  readonly businessTaxRate = signal(0);
  readonly laborRates = signal<LaborRate[]>([]);
  readonly inventoryQuery = signal('');
  readonly inventoryItems = signal<InventoryItem[]>([]);
  readonly quoteLineItems = signal<InvoiceLineItem[]>([]);

  readonly sendEmail = signal(true);
  readonly sendSms = signal(false);
  readonly selectedEmailTargets = signal<string[]>([]);
  readonly selectedPhoneTargets = signal<string[]>([]);

  readonly staffNote = signal('');
  readonly customerNote = signal('');

  private pendingCustomerId = '';
  private readonly customerPrefill = signal<CustomerPrefill | null>(null);
  private lastToastKey = '';
  private lastToastAt = 0;

  readonly documentLabel = computed(() => this.documentType() === 'quote' ? 'Quote' : 'Invoice');
  readonly documentLabelLower = computed(() => this.documentLabel().toLowerCase());
  readonly companyName = computed(() => this.businessProfile.companyName() || 'Your Company');
  readonly companyPhone = computed(() => this.businessProfile.companyPhone() || '');
  readonly companyEmail = computed(() => this.businessProfile.companyEmail() || '');
  readonly companyAddress = computed(() => this.businessProfile.companyAddress() || '');
  readonly logoUrl = computed(() => this.branding.logoUrl() || '');

  readonly filteredCustomers = computed(() => {
    const query = this.customerQuery().trim().toLowerCase();
    const source = this.customers();
    if (!query) return this.recentLeadCustomers();
    return source
      .filter(customer => {
        const haystack = [
          this.customerDisplayName(customer),
          customer.email || '',
          customer.secondaryEmail || '',
          customer.phone || '',
          customer.mobile || '',
          this.customerVehicleSummary(customer)
        ]
          .join(' ')
          .toLowerCase();
        return haystack.includes(query);
      })
      .slice(0, 25);
  });

  readonly selectedCustomerName = computed(() => this.customerDisplayName(this.selectedCustomer()));
  readonly selectedCustomerVehicle = computed(() => this.customerVehicleSummary(this.selectedCustomer()) || 'Vehicle not set');
  readonly hasSelectedCustomer = computed(() => !!this.selectedCustomer());
  readonly draftBadge = computed(() => (this.draftId() ? 'Saved as draft' : 'Not saved'));
  readonly quoteNumberDisplay = computed(() => {
    const draft = this.currentDraft();
    if (draft?.invoiceNumber) return draft.invoiceNumber;
    return this.invoicesData.previewNextDocumentNumber('quote');
  });
  readonly quoteDateDisplay = computed(() => this.formatDisplayDate(this.currentDraft()?.issueDate || this.todayIso()));
  readonly quoteExpirationDisplay = computed(() =>
    this.formatDisplayDate(this.currentDraft()?.dueDate || this.plusDaysIso(this.todayIso(), 30))
  );

  readonly availableDocumentTemplates = computed(() =>
    this.documentTemplates().filter(template => template.documentType === 'both' || template.documentType === this.documentType())
  );

  readonly selectedTemplate = computed(() => {
    const id = this.selectedTemplateId();
    return this.availableDocumentTemplates().find(item => item.id === id) || null;
  });

  readonly templateDisplayName = computed(() => {
    const selected = this.selectedTemplate();
    if (selected?.name) return selected.name;
    if (this.saveManualAsTemplate() && this.manualTemplateName().trim()) {
      return this.manualTemplateName().trim();
    }
    return this.documentType() === 'invoice' ? 'Manual invoice' : 'Manual quote';
  });

  readonly templateSubject = computed(() => {
    return this.selectedTemplateSubject().trim() || this.selectedTemplate()?.subject || this.manualTemplateSubject().trim() || `Quote from ${this.companyName()}`;
  });

  readonly availableEmailTargets = computed(() => {
    const customer = this.selectedCustomer();
    const values = [customer?.email, customer?.secondaryEmail].map(value => String(value || '').trim()).filter(Boolean);
    return Array.from(new Set(values));
  });

  readonly availablePhoneTargets = computed(() => {
    const customer = this.selectedCustomer();
    const values = [customer?.phone, customer?.mobile].map(value => String(value || '').trim()).filter(Boolean);
    return Array.from(new Set(values));
  });

  readonly filteredInventoryItems = computed(() => {
    const query = this.inventoryQuery().trim().toLowerCase();
    const source = this.inventoryItems();
    if (!query) return source.slice(0, 40);
    return source
      .filter(item => {
        const haystack = [item.name, item.sku, item.vendor, item.category].join(' ').toLowerCase();
        return haystack.includes(query);
      })
      .slice(0, 40);
  });

  readonly quoteParts = computed(() => this.quoteLineItems().filter(item => item.type === 'part'));
  readonly quoteLabor = computed(() => this.quoteLineItems().filter(item => item.type === 'labor'));
  readonly quoteSubtotal = computed(() => this.roundCurrency(this.quoteLineItems().reduce((sum, item) => sum + item.lineSubtotal, 0)));
  readonly quoteTaxTotal = computed(() => this.roundCurrency(this.quoteLineItems().reduce((sum, item) => sum + item.taxAmount, 0)));
  readonly quoteGrandTotal = computed(() => this.roundCurrency(this.quoteSubtotal() + this.quoteTaxTotal()));

  readonly canContinue = computed(() => {
    const step = this.wizardStep();
    if (step === 1) return this.hasSelectedCustomer();
    if (step === 2) {
      const hasTemplate = !!this.selectedTemplate();
      const hasBody = !!this.manualTemplateBody().trim();
      const hasLines = this.quoteLineItems().length > 0;
      const hasNameWhenSaving = !this.saveManualAsTemplate() || !!this.manualTemplateName().trim();
      const hasBodyWhenSaving = !this.saveManualAsTemplate() || hasBody;
      return (hasTemplate || hasBody || hasLines) && hasNameWhenSaving && hasBodyWhenSaving;
    }
    if (step === 3) return this.deliverySelectionValid();
    return true;
  });

  readonly previewHtml = computed(() => this.buildPreviewHtml());

  readonly stepItems = [
    { id: 1 as WizardStep, title: 'Customer' },
    { id: 2 as WizardStep, title: 'Template' },
    { id: 3 as WizardStep, title: 'Delivery' },
    { id: 4 as WizardStep, title: 'Notes' },
    { id: 5 as WizardStep, title: 'Review & Send' }
  ];

  constructor() {
    this.loadInitialData();

    this.route.queryParamMap.subscribe(params => {
      this.pendingCustomerId = (params.get('customerId') || '').trim();
      this.documentType.set(this.parseDocumentType(params.get('type')));
      const prefill: CustomerPrefill = {
        name: (params.get('customerName') || '').trim(),
        email: (params.get('customerEmail') || '').trim(),
        phone: (params.get('customerPhone') || '').trim(),
        vehicle: (params.get('customerVehicle') || '').trim()
      };
      this.customerPrefill.set(Object.values(prefill).some(Boolean) ? prefill : null);
      this.trySelectPendingCustomer();
    });
  }

  setWizardStep(step: WizardStep): void {
    if (step > 1 && !this.hasSelectedCustomer()) return;
    if (step > 3 && !this.deliverySelectionValid()) return;
    if (step > this.wizardStep() + 1) return;
    this.wizardStep.set(step);
  }

  async continueStep(): Promise<void> {
    if (!this.canContinue()) return;
    const current = this.wizardStep();

    if (current === 1) {
      await this.ensureDraftSaved();
      this.wizardStep.set(2);
      return;
    }

    if (current === 2) {
      await this.maybeSaveManualTemplate();
      await this.ensureDraftSaved();
      this.wizardStep.set(3);
      return;
    }

    if (current === 3) {
      this.wizardStep.set(4);
      return;
    }

    if (current === 4) {
      await this.ensureDraftSaved();
      this.wizardStep.set(5);
      return;
    }
  }

  previousStep(): void {
    const current = this.wizardStep();
    if (current <= 1) return;
    this.wizardStep.set((current - 1) as WizardStep);
  }

  setCustomerQuery(value: string): void {
    this.customerQuery.set(value || '');
  }

  selectCustomer(customer: Customer): void {
    this.selectedCustomer.set(customer);
    this.seedTargetsFromCustomer(customer);
    this.clearStatus();
  }

  isSelectedCustomer(customer: Customer): boolean {
    const selected = this.selectedCustomer();
    if (!selected) return false;
    return String(selected.id || '').trim() === String(customer.id || '').trim();
  }

  selectExistingTemplate(template: DocumentTemplate): void {
    this.selectedTemplateId.set(template.id);
    this.selectedTemplateSubject.set(template.subject || '');
    this.manualTemplateSubject.set(String(template.subject || '').trim() || this.manualTemplateSubject());
    this.manualTemplateBody.set(String(template.body || '').trim() || this.manualTemplateBody());
    this.applyDocumentTemplatePrefill(template);
  }

  onTemplateSelectionChange(value: string | null | undefined): void {
    const id = String(value || '').trim();
    this.selectedTemplateId.set(id);
    if (!id) {
      this.selectedTemplateSubject.set('');
      return;
    }
    const template = this.availableDocumentTemplates().find(item => item.id === id) || null;
    if (!template) return;
    this.selectExistingTemplate(template);
  }

  async createTemplate(): Promise<void> {
    if (this.creatingTemplate()) return;
    const name = this.manualTemplateName().trim();
    const subject = this.manualTemplateSubject().trim();
    const body = this.manualTemplateBody().trim();
    if (!name || !subject || !body) {
      this.setStatus('Template name, subject, and body are required.', 'error');
      return;
    }

    this.creatingTemplate.set(true);
    this.clearStatus();
    try {
      const created: DocumentTemplate = {
        id: `tmpl-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name,
        documentType: this.documentType(),
        subject,
        body,
        partItemIds: [],
        laborRateIds: []
      };
      const nextTemplates = [...this.documentTemplates(), created];
      await firstValueFrom(
        this.settingsApi.setValue<DocumentTemplate[]>(
          BUSINESS_DOCUMENT_TEMPLATES_SETTING_KEY,
          this.normalizeDocumentTemplates(nextTemplates)
        )
      );
      this.documentTemplates.set(this.normalizeDocumentTemplates(nextTemplates));
      if (created) {
        this.selectExistingTemplate(created);
      }
      this.setStatus('Template saved.', 'success');
    } catch {
      this.setStatus('Could not save template.', 'error');
    } finally {
      this.creatingTemplate.set(false);
    }
  }

  toggleEmailTarget(value: string, checked: boolean): void {
    this.selectedEmailTargets.update(current => {
      const next = new Set(current);
      if (checked) next.add(value);
      else next.delete(value);
      return Array.from(next);
    });
  }

  togglePhoneTarget(value: string, checked: boolean): void {
    this.selectedPhoneTargets.update(current => {
      const next = new Set(current);
      if (checked) next.add(value);
      else next.delete(value);
      return Array.from(next);
    });
  }

  async sendQuote(): Promise<void> {
    if (this.sending()) return;
    if (!this.canContinue()) {
      this.setStatus('Complete all required steps before sending.', 'error');
      return;
    }
    const customer = this.selectedCustomer();
    const draft = await this.ensureDraftSaved();
    if (!customer || !draft) {
      this.setStatus('Could not prepare quote.', 'error');
      return;
    }

    this.sending.set(true);
    this.clearStatus();
    try {
      const html = this.previewHtml();
      const subject = this.resolveMergeTags(this.templateSubject());
      const sends: Array<{ channel: 'email' | 'sms'; promise: Promise<unknown> }> = [];

      if (this.sendEmail() && this.selectedEmailTargets().length) {
        for (const target of this.selectedEmailTargets()) {
          sends.push({
            channel: 'email',
            promise: firstValueFrom(
              this.emailApi.sendToCustomer({
                customerId: String(customer.id || '').trim(),
                customerName: this.customerDisplayName(customer),
                to: target,
                subject,
                message: this.stripHtml(html),
                html
              })
            )
          });
        }
      }

      if (this.sendSms() && this.selectedPhoneTargets().length) {
        const smsBody = this.buildSmsMessage();
        for (const target of this.selectedPhoneTargets()) {
          sends.push({
            channel: 'sms',
            promise: firstValueFrom(
              this.smsApi.sendToCustomer({
                customerId: String(customer.id || '').trim(),
                customerName: this.customerDisplayName(customer),
                to: target,
                message: smsBody
              })
            )
          });
        }
      }

      if (!sends.length) {
        this.setStatus('Pick at least one delivery target.', 'error');
        this.sending.set(false);
        return;
      }

      const settled = await Promise.allSettled(sends.map(item => item.promise));
      const outcomes = sends.map((item, index) => ({ channel: item.channel, result: settled[index] }));
      const attemptedEmail = outcomes.some(item => item.channel === 'email');
      const attemptedSms = outcomes.some(item => item.channel === 'sms');
      const emailSuccess = outcomes.some(row => row.channel === 'email' && row.result.status === 'fulfilled');
      const smsSuccess = outcomes.some(row => row.channel === 'sms' && row.result.status === 'fulfilled');
      const emailFailureReason = outcomes
        .filter(row => row.channel === 'email' && row.result.status === 'rejected')
        .map(row => this.extractSendFailureReason((row.result as PromiseRejectedResult).reason))
        .find(Boolean);
      const smsFailureReason = outcomes
        .filter(row => row.channel === 'sms' && row.result.status === 'rejected')
        .map(row => this.extractSendFailureReason((row.result as PromiseRejectedResult).reason))
        .find(Boolean);

      if (!emailSuccess && !smsSuccess) {
        this.setStatus(`Could not send ${this.documentLabelLower()}.`, 'error');
        return;
      }

      const sent = this.invoicesData.saveInvoice({
        ...draft,
        stage: 'sent',
        template: this.templateDisplayName(),
        staffNote: this.staffNote(),
        customerNote: this.customerNote()
      });
      this.draftSavedAt.set(sent.updatedAt || new Date().toISOString());

      if (emailSuccess && smsSuccess) {
        this.setStatus(`${this.documentLabel()} sent successfully.`, 'success');
      } else if (emailSuccess && attemptedSms && !smsSuccess) {
        this.setStatus(
          `${this.documentLabel()} sent by email. SMS failed${smsFailureReason ? ` (${smsFailureReason})` : ''}.`,
          'neutral'
        );
      } else if (smsSuccess && attemptedEmail && !emailSuccess) {
        this.setStatus(
          `${this.documentLabel()} sent by SMS. Email failed${emailFailureReason ? ` (${emailFailureReason})` : ''}.`,
          'neutral'
        );
      } else {
        this.setStatus(`${this.documentLabel()} sent successfully.`, 'success');
      }
      await this.router.navigate(['/invoices', sent.id]);
    } catch {
      this.setStatus(`Could not send ${this.documentLabelLower()}.`, 'error');
    } finally {
      this.sending.set(false);
    }
  }

  trackCustomer(_index: number, customer: Customer): string {
    return String(customer.id || '').trim() || this.customerDisplayName(customer);
  }

  trackStep(_index: number, step: { id: WizardStep }): number {
    return step.id;
  }

  trackInventory(_index: number, item: InventoryItem): string {
    return String(item.id || '').trim() || `${item.sku}-${item.name}`;
  }

  trackLineItem(_index: number, line: InvoiceLineItem): string {
    return line.id;
  }

  private async loadInitialData(): Promise<void> {
    this.loading.set(true);
    try {
      const [customersRes, templatesRes, quoteTerms, inventoryRes, taxRateValue, laborRates, documentTemplatesValue] = await Promise.all([
        firstValueFrom(this.customersApi.list()),
        firstValueFrom(this.emailApi.listTemplates()),
        this.loadEmailFooterTerms(),
        firstValueFrom(this.inventoryApi.listItems()),
        firstValueFrom(this.settingsApi.getValue<number | string>(BUSINESS_TAX_RATE_SETTING_KEY)),
        firstValueFrom(this.settingsApi.getValue<LaborRate[]>(BUSINESS_LABOR_RATES_SETTING_KEY)),
        firstValueFrom(this.settingsApi.getValue<DocumentTemplate[]>(BUSINESS_DOCUMENT_TEMPLATES_SETTING_KEY))
      ]);

      const customers = Array.isArray(customersRes) ? customersRes : [];
      this.customers.set(customers);
      this.emailTemplates.set(Array.isArray(templatesRes.templates) ? templatesRes.templates : []);
      this.emailSignature.set(String(templatesRes.signature || '').trim());
      this.quoteTerms.set(String(quoteTerms || '').trim());
      this.inventoryItems.set(Array.isArray(inventoryRes?.items) ? inventoryRes.items : []);
      this.businessTaxRate.set(this.normalizeTaxRate(taxRateValue));
      this.laborRates.set(
        (Array.isArray(laborRates) ? laborRates : [])
          .map((item, index) => ({
            id: String(item?.id || '').trim() || `labor-${index}`,
            name: String(item?.name || '').trim(),
            price: this.roundCurrency(Math.max(0, Number(item?.price) || 0)),
            taxable: !!item?.taxable
          }))
          .filter(item => !!item.name)
      );
      this.documentTemplates.set(this.normalizeDocumentTemplates(documentTemplatesValue));
      this.computeRecentLeadCustomers(customers);
      this.trySelectPendingCustomer();
    } catch {
      this.setStatus('Could not load quote wizard data.', 'error');
    } finally {
      this.loading.set(false);
    }
  }

  private async computeRecentLeadCustomers(customers: Customer[]): Promise<void> {
    this.recentLeadsLoading.set(true);
    try {
      const [lanes, items] = await Promise.all([
        firstValueFrom(this.lanesApi.list()),
        firstValueFrom(this.workItemsApi.list())
      ]);
      const leadLaneIds = this.leadLaneIds(lanes || []);
      const recentLeadIds = this.recentLeadCustomerIds(items || [], leadLaneIds);
      const customerById = new Map(customers.map(item => [String(item.id || '').trim(), item]));
      const leads = recentLeadIds
        .map(id => customerById.get(id) || null)
        .filter((item): item is Customer => !!item)
        .slice(0, 5);

      if (leads.length) {
        this.recentLeadCustomers.set(leads);
        this.recentLeadsLoading.set(false);
        return;
      }
    } catch {
      // Fallback below.
    }

    const fallback = [...customers]
      .sort((a, b) => this.asMillis(b.createdAt) - this.asMillis(a.createdAt))
      .slice(0, 5);
    this.recentLeadCustomers.set(fallback);
    this.recentLeadsLoading.set(false);
  }

  private leadLaneIds(lanes: Lane[]): Set<string> {
    const ids = new Set<string>();
    for (const lane of lanes || []) {
      const stageKey = String(lane.stageKey || '').trim().toLowerCase();
      const name = String(lane.name || '').trim().toLowerCase();
      if (stageKey === 'lead' || /lead/.test(name)) {
        const id = String(lane.id || '').trim();
        if (id) ids.add(id);
      }
    }
    return ids;
  }

  private recentLeadCustomerIds(items: WorkItem[], leadLaneIds: Set<string>): string[] {
    const leadItems = (items || [])
      .filter(item => leadLaneIds.has(String(item.laneId || '').trim()))
      .sort((a, b) => this.asMillis(b.createdAt) - this.asMillis(a.createdAt));

    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of leadItems) {
      const customerId = String(item.customerId || '').trim();
      if (!customerId || seen.has(customerId)) continue;
      seen.add(customerId);
      out.push(customerId);
      if (out.length >= 5) break;
    }
    return out;
  }

  private async ensureDraftSaved(): Promise<InvoiceDetail | null> {
    const customer = this.selectedCustomer();
    if (!customer) return null;

    const payload = this.buildDraftPayload(customer);

    if (!this.draftId()) {
      const created = this.invoicesData.createDraftInvoice(payload);
      this.draftId.set(created.id);
      this.draftSavedAt.set(created.updatedAt || new Date().toISOString());
      this.currentDraft.set(created);
      this.setStatus(`${this.documentLabel()} saved as draft.`, 'success');
      return created;
    }

    const existing = this.invoicesData.getInvoiceById(this.draftId() || '');
    if (!existing) {
      this.draftId.set(null);
      return this.ensureDraftSaved();
    }

    const updated = this.invoicesData.saveInvoice({
      ...existing,
      id: existing.id,
      invoiceNumber: existing.invoiceNumber,
      documentType: this.documentType(),
      customerId: payload.customerId || existing.customerId || '',
      customerName: payload.customerName || existing.customerName || 'Customer',
      customerEmail: payload.customerEmail || existing.customerEmail || '',
      customerPhone: payload.customerPhone || existing.customerPhone || '',
      customerAddress: payload.customerAddress || existing.customerAddress || '',
      vehicle: payload.vehicle || existing.vehicle || 'Vehicle TBD',
      businessName: payload.businessName || existing.businessName || 'Shop',
      businessEmail: payload.businessEmail || existing.businessEmail || '',
      businessPhone: payload.businessPhone || existing.businessPhone || '',
      businessAddress: payload.businessAddress || existing.businessAddress || '',
      businessLogoUrl: payload.businessLogoUrl || existing.businessLogoUrl || '',
      template: payload.template || existing.template || 'Other',
      staffNote: payload.staffNote || existing.staffNote || '',
      customerNote: payload.customerNote || existing.customerNote || '',
      lineItems: this.quoteLineItems(),
      stage: existing.stage || 'draft'
    });
    this.draftSavedAt.set(updated.updatedAt || new Date().toISOString());
    this.currentDraft.set(updated);
    return updated;
  }

  private async maybeSaveManualTemplate(): Promise<void> {
    if (!this.saveManualAsTemplate()) return;
    if (this.selectedTemplate()) return;
    if (this.creatingTemplate()) return;
    const name = this.manualTemplateName().trim();
    const subject = this.manualTemplateSubject().trim();
    const body = this.manualTemplateBody().trim();
    if (!name || !subject || !body) {
      this.setStatus('Template name, subject, and body are required when saving a template.', 'error');
      return;
    }

    this.creatingTemplate.set(true);
    try {
      const newTemplate: DocumentTemplate = {
        id: `tmpl-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        name,
        documentType: this.documentType(),
        subject,
        body,
        partItemIds: [],
        laborRateIds: []
      };
      const nextTemplates = [...this.documentTemplates(), newTemplate];
      await firstValueFrom(
        this.settingsApi.setValue<DocumentTemplate[]>(
          BUSINESS_DOCUMENT_TEMPLATES_SETTING_KEY,
          this.normalizeDocumentTemplates(nextTemplates)
        )
      );
      this.documentTemplates.set(this.normalizeDocumentTemplates(nextTemplates));
      this.setStatus('Template saved for later use.', 'success');
    } catch {
      this.setStatus('Could not save template.', 'error');
    } finally {
      this.creatingTemplate.set(false);
    }
  }

  private buildDraftPayload(customer: Customer): InvoiceDraftPayload {
    const profile = this.businessProfile.profile();
    const issueDate = this.currentDraft()?.issueDate || this.todayIso();
    const dueDate = this.currentDraft()?.dueDate || this.plusDaysIso(issueDate, 30);
    return {
      documentType: this.documentType(),
      customerId: String(customer.id || '').trim() || undefined,
      customerName: this.customerDisplayName(customer),
      customerEmail: String(customer.email || '').trim() || undefined,
      customerPhone: String(customer.phone || customer.mobile || '').trim() || undefined,
      customerAddress: this.customerAddressSummary(customer) || undefined,
      vehicle: this.customerVehicleSummary(customer) || 'Vehicle TBD',
      businessName: String(profile.companyName || '').trim() || 'Your Company',
      businessEmail: String(profile.companyEmail || '').trim() || undefined,
      businessPhone: String(profile.companyPhone || '').trim() || undefined,
      businessAddress: String(profile.companyAddress || '').trim() || undefined,
      businessLogoUrl: String(this.logoUrl() || '').trim() || undefined,
      template: this.templateDisplayName(),
      staffNote: this.staffNote(),
      customerNote: this.customerNote(),
      lineItems: this.quoteLineItems(),
      issueDate,
      dueDate,
      stage: 'draft'
    };
  }

  setInventoryQuery(value: string): void {
    this.inventoryQuery.set(String(value || ''));
  }

  addInventoryPart(item: InventoryItem): void {
    const price = this.safeNumber(item?.unitCost, 0);
    const line = this.recalculateLine({
      id: `li-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: 'part',
      code: String(item?.sku || '').trim(),
      description: String(item?.name || '').trim() || 'Part',
      quantity: 1,
      unitPrice: price,
      taxRate: this.businessTaxRate(),
      lineSubtotal: 0,
      taxAmount: 0,
      lineTotal: 0
    });
    this.quoteLineItems.update(current => [...current, line]);
    this.clearStatus();
  }

  addManualLabor(): void {
    const line = this.recalculateLine({
      id: `li-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: 'labor',
      code: '',
      description: 'Labor',
      quantity: 1,
      unitPrice: 0,
      taxRate: this.businessTaxRate(),
      lineSubtotal: 0,
      taxAmount: 0,
      lineTotal: 0
    });
    this.quoteLineItems.update(current => [...current, line]);
    this.clearStatus();
  }

  addSavedLaborRate(rate: LaborRate): void {
    const line = this.recalculateLine({
      id: `li-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      type: 'labor',
      code: '',
      description: String(rate?.name || '').trim() || 'Labor',
      quantity: 1,
      unitPrice: this.safeNumber(rate?.price, 0),
      taxRate: rate?.taxable ? this.businessTaxRate() : 0,
      lineSubtotal: 0,
      taxAmount: 0,
      lineTotal: 0
    });
    this.quoteLineItems.update(current => [...current, line]);
    this.clearStatus();
  }

  private applyDocumentTemplatePrefill(template: DocumentTemplate): void {
    const inventoryById = new Map(this.inventoryItems().map(item => [String(item.id || '').trim(), item]));
    const laborById = new Map(this.laborRates().map(rate => [String(rate.id || '').trim(), rate]));
    const lines: InvoiceLineItem[] = [];

    for (const partId of template.partItemIds || []) {
      const item = inventoryById.get(String(partId || '').trim());
      if (!item) continue;
      lines.push(this.recalculateLine({
        id: `li-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        type: 'part',
        code: String(item.sku || '').trim(),
        description: String(item.name || '').trim() || 'Part',
        quantity: 1,
        unitPrice: this.safeNumber(item.unitCost, 0),
        taxRate: this.businessTaxRate(),
        lineSubtotal: 0,
        taxAmount: 0,
        lineTotal: 0
      }));
    }

    for (const laborId of template.laborRateIds || []) {
      const rate = laborById.get(String(laborId || '').trim());
      if (!rate) continue;
      lines.push(this.recalculateLine({
        id: `li-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        type: 'labor',
        code: '',
        description: String(rate.name || '').trim() || 'Labor',
        quantity: 1,
        unitPrice: this.safeNumber(rate.price, 0),
        taxRate: rate.taxable ? this.businessTaxRate() : 0,
        lineSubtotal: 0,
        taxAmount: 0,
        lineTotal: 0
      }));
    }

    if (lines.length) {
      this.quoteLineItems.set(lines);
    }
  }

  removeQuoteLineItem(lineId: string): void {
    const id = String(lineId || '').trim();
    if (!id) return;
    this.quoteLineItems.update(current => current.filter(item => item.id !== id));
    this.clearStatus();
  }

  updateQuoteLineItem(
    lineId: string,
    field: 'description' | 'code' | 'quantity' | 'unitPrice' | 'taxRate',
    rawValue: string
  ): void {
    const id = String(lineId || '').trim();
    if (!id) return;
    this.quoteLineItems.update(current =>
      current.map(item => {
        if (item.id !== id) return item;
        const next: InvoiceLineItem = { ...item };
        if (field === 'description' || field === 'code') {
          next[field] = String(rawValue || '');
        } else {
          const numeric = this.safeNumber(rawValue, field === 'quantity' ? 1 : 0);
          (next[field] as number) = numeric < 0 ? 0 : numeric;
        }
        return this.recalculateLine(next);
      })
    );
    this.clearStatus();
  }

  private normalizeDocumentTemplates(value: unknown): DocumentTemplate[] {
    const source = Array.isArray(value) ? value : [];
    return source
      .map((item, index) => {
        const row = item && typeof item === 'object' ? (item as Partial<DocumentTemplate>) : null;
        if (!row) return null;
        const id = String(row.id || '').trim() || `tmpl-${Date.now()}-${index}`;
        const name = String(row.name || '').trim();
        if (!name) return null;
        const typeRaw = String(row.documentType || '').trim().toLowerCase();
        const documentType: DocumentTemplateType =
          typeRaw === 'invoice' ? 'invoice' : typeRaw === 'both' ? 'both' : 'quote';
        return {
          id,
          name,
          documentType,
          subject: String(row.subject || '').trim() || 'Quote for {{customer_name}}',
          body: String(row.body || '').trim() || '<p>Hi {{customer_name}},</p><p>Here is your quote for {{vehicle_summary}}.</p>',
          partItemIds: Array.isArray(row.partItemIds)
            ? row.partItemIds.map(idValue => String(idValue || '').trim()).filter(Boolean)
            : [],
          laborRateIds: Array.isArray(row.laborRateIds)
            ? row.laborRateIds.map(idValue => String(idValue || '').trim()).filter(Boolean)
            : []
        };
      })
      .filter((item): item is DocumentTemplate => !!item);
  }

  private seedTargetsFromCustomer(customer: Customer): void {
    const firstEmail = [customer.email, customer.secondaryEmail].map(value => String(value || '').trim()).find(Boolean) || '';
    const firstPhone = [customer.phone, customer.mobile].map(value => String(value || '').trim()).find(Boolean) || '';
    this.selectedEmailTargets.set(firstEmail ? [firstEmail] : []);
    this.selectedPhoneTargets.set(firstPhone ? [firstPhone] : []);
  }

  private trySelectPendingCustomer(): void {
    if (this.selectedCustomer()) return;

    if (this.pendingCustomerId) {
      const byId = this.customers().find(item => String(item.id || '').trim() === this.pendingCustomerId) || null;
      if (byId) {
        this.selectCustomer(byId);
        this.pendingCustomerId = '';
        return;
      }
    }

    const prefill = this.customerPrefill();
    if (!prefill) return;

    const byEmail = this.customers().find(item => String(item.email || '').trim().toLowerCase() === prefill.email.toLowerCase()) || null;
    if (byEmail) {
      this.selectCustomer(byEmail);
      return;
    }
  }

  private parseDocumentType(value: string | null): InvoiceDocumentType {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'invoice' ? 'invoice' : 'quote';
  }

  customerDisplayName(customer: Customer | null | undefined): string {
    if (!customer) return 'Customer';
    const name = String(customer.name || '').trim();
    if (name) return name;
    const first = String(customer.firstName || '').trim();
    const last = String(customer.lastName || '').trim();
    return `${first} ${last}`.trim() || 'Customer';
  }

  customerVehicleSummary(customer: Customer | null | undefined): string {
    if (!customer) return '';
    return [customer.vehicleYear, customer.vehicleMake, customer.vehicleModel, customer.vehicleTrim]
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .join(' ');
  }

  private customerAddressSummary(customer: Customer | null | undefined): string {
    if (!customer) return '';
    const merged = [
      customer.address,
      customer.address1,
      customer.address2,
      customer.address3,
      customer.town,
      customer.state,
      customer.postcode
    ]
      .map(value => String(value || '').trim())
      .filter(Boolean);
    return Array.from(new Set(merged)).join(', ');
  }

  private asMillis(value: string | null | undefined): number {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private buildPreviewHtml(): string {
    const customer = this.selectedCustomer();
    const customerName = this.customerDisplayName(customer);
    const vehicle = this.customerVehicleSummary(customer) || 'Vehicle details pending';
    const noteToCustomer = this.customerNote().trim();
    const subject = this.resolveMergeTags(this.templateSubject());
    const quoteNumber = this.quoteNumberDisplay();
    const quoteDate = this.quoteDateDisplay();
    const quoteExpiration = this.quoteExpirationDisplay();
    const businessAddress = this.formatAddressHtml(this.companyAddress());

    const baseBody = String(this.selectedTemplate()?.body || '').trim() || String(this.manualTemplateBody() || '').trim();

    const bodySource = baseBody || `<p>Hi {{customer_name}},</p><p>Here is your quote for {{vehicle_summary}}.</p>`;
    const resolvedBody = this.stripInlineQuoteActionLinks(this.resolveMergeTags(bodySource));
    const signature = this.includeSignature() ? this.resolveMergeTags(this.emailSignature()) : '';
    const terms = this.renderTermsHtml();
    const logo = this.includeLogo() && this.logoUrl()
      ? `<img src="${this.logoUrl()}" alt="${this.companyName()} logo" style="max-width:180px;height:auto;display:block;margin-bottom:14px;" />`
      : '';

    const customerNoteHtml = noteToCustomer
      ? `<div style="margin-top:14px;padding:10px 12px;border:1px solid #d5d9e2;border-radius:8px;background:#f8fafc;"><strong>Note:</strong><br/>${this.escapeHtml(noteToCustomer)}</div>`
      : '';
    const lineItemsHtml = this.renderLineItemsHtml();
    const totalsHtml = this.renderTotalsHtml();
    const quoteActionsHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 8px;width:100%;">
      <tr>
        <td align="center" style="text-align:center;vertical-align:middle;">
          <a href="${this.quoteActionUrl('accept')}" style="display:inline-block;background:#1d4ed8;border:1px solid #1d4ed8;color:#ffffff !important;text-decoration:none;font-weight:700;font-size:16px;line-height:1;padding:10px 16px;border-radius:6px;margin-right:16px;">Accept Quote</a>
          <a href="${this.quoteActionUrl('decline')}" style="display:inline-block;color:#0369a1 !important;text-decoration:underline;font-weight:600;font-size:16px;line-height:1;vertical-align:middle;">Decline Quote</a>
        </td>
      </tr>
    </table>`;

    return `<style>
      .pf-preview-root, .pf-preview-root * {
        color: #0f172a !important;
        opacity: 1 !important;
      }
      .pf-preview-root a {
        color: #0369a1 !important;
      }
      .pf-preview-root img {
        max-width: 220px !important;
        width: auto !important;
        height: auto !important;
      }
      .pf-preview-root table { width: 100%; border-collapse: collapse; }
      .pf-preview-root td, .pf-preview-root th { border-color: #cbd5e1 !important; }
      .pf-preview-root th { text-align: left !important; }
    </style>
    <div class="pf-preview-root" style="font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.5;font-size:14px;background:#ffffff;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:14px;">
        <tr>
          <td style="vertical-align:top;width:52%;padding-right:14px;">
            ${logo}
            <div style="font-size:26px;font-weight:800;letter-spacing:0.04em;line-height:1.1;margin-bottom:8px;">${this.escapeHtml(this.companyName())}</div>
            <div style="color:#334155;">${businessAddress}</div>
          </td>
          <td style="vertical-align:top;width:48%;">
            <div>
              <div><strong>Date:</strong> ${this.escapeHtml(quoteDate)}</div>
              <div><strong>Quote Number:</strong> ${this.escapeHtml(quoteNumber)}</div>
              <div><strong>Expiration Date:</strong> ${this.escapeHtml(quoteExpiration)}</div>
            </div>
          </td>
        </tr>
      </table>
      <h2 style="margin:0 0 8px 0;font-size:22px;">${this.escapeHtml(subject)}</h2>
      <div style="margin-bottom:10px;color:#475569;">Vehicle: ${this.escapeHtml(vehicle)}</div>
      <div>${resolvedBody}</div>
      ${lineItemsHtml}
      ${totalsHtml}
      ${quoteActionsHtml}
      ${customerNoteHtml}
      ${terms}
      ${signature ? `<div style="margin-top:18px;">${this.resolveMergeTags(signature)}</div>` : ''}
    </div>`;
  }

  private buildSmsMessage(): string {
    const customer = this.selectedCustomer();
    const customerName = this.customerDisplayName(customer);
    return `${this.companyName()}: Quote ready for ${customerName}. View: ${this.quotePublicUrl()} | Accept: ${this.quoteActionUrl('accept')} | Decline: ${this.quoteActionUrl('decline')}`;
  }

  private quotePublicUrl(): string {
    return this.quoteActionUrl('view');
  }

  private quoteActionUrl(action: 'accept' | 'decline' | 'view'): string {
    const id = this.draftId() || 'preview';
    const path = action === 'accept' ? '/quote-accepted' : action === 'decline' ? '/quote-declined' : '/quote-response';
    const query = new URLSearchParams();
    query.set('action', action);
    query.set('quoteId', id);
    query.set('tenantId', String(this.tenantContext.tenantId() || 'main').trim().toLowerCase() || 'main');
    query.set('quoteNumber', this.quoteNumberDisplay());
    query.set('customerName', this.customerDisplayName(this.selectedCustomer()));
    query.set('vehicle', this.customerVehicleSummary(this.selectedCustomer()) || 'Vehicle details pending');
    query.set('businessName', this.companyName());
    const base = this.publicAppBaseUrl();
    return `${base}${path}?${query.toString()}`;
  }

  private publicAppBaseUrl(): string {
    const configured = String(environment.publicAppUrl || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    if (typeof window !== 'undefined' && window.location?.origin) {
      return window.location.origin.replace(/\/+$/, '');
    }
    return '';
  }

  private resolveMergeTags(source: string): string {
    const customer = this.selectedCustomer();
    const values: Record<string, string> = {
      customer_name: this.customerDisplayName(customer),
      customer_email: String(customer?.email || '').trim(),
      customer_phone: String(customer?.phone || customer?.mobile || '').trim(),
      vehicle_summary: this.customerVehicleSummary(customer),
      company_name: this.companyName(),
      company_email: this.companyEmail(),
      company_phone: this.companyPhone(),
      company_address: this.companyAddress(),
      quote_number: this.quoteNumberDisplay(),
      quote_date: this.quoteDateDisplay(),
      quote_expiration_date: this.quoteExpirationDisplay(),
      quote_link: this.quotePublicUrl(),
      quote_accept_url: this.quoteActionUrl('accept'),
      quote_decline_url: this.quoteActionUrl('decline')
    };

    return String(source || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_match, key: string) => {
      const lookup = String(key || '').trim().toLowerCase();
      return Object.prototype.hasOwnProperty.call(values, lookup) ? values[lookup] : '';
    });
  }

  private stripHtml(value: string): string {
    return String(value || '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private stripInlineQuoteActionLinks(value: string): string {
    const source = String(value || '');
    if (!source) return '';
    return source
      .replace(/<a\b[^>]*>\s*Accept Quote\s*<\/a>/gi, '')
      .replace(/<a\b[^>]*>\s*Decline Quote\s*<\/a>/gi, '')
      .replace(/\bAccept Quote\b/gi, '')
      .replace(/\bDecline Quote\b/gi, '');
  }

  private escapeHtml(value: string): string {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private renderTermsHtml(): string {
    const raw = String(this.quoteTerms() || '').trim();
    if (!raw) return '';
    const resolved = this.resolveMergeTags(raw);
    const body = /<[^>]+>/.test(resolved)
      ? resolved
      : this.escapeHtml(resolved).replace(/\n/g, '<br/>');
    return `<div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>
    <div data-pathflow-footer-terms="1" style="border-top:1px solid #d5d9e2;padding-top:14px;">
      <div style="display:inline-block;background:#e5e7eb;padding:4px 8px;font-weight:700;margin-bottom:8px;">Terms:</div>
      <div>${body}</div>
    </div>`;
  }

  private renderLineItemsHtml(): string {
    const parts = this.quoteParts();
    const labor = this.quoteLabor();
    if (!parts.length && !labor.length) return '';

    const renderRows = (lines: InvoiceLineItem[]): string =>
      lines
        .map(line => `<tr>
          <td style="width:58%;padding:7px 10px;border-bottom:1px solid #9ca3af;vertical-align:top;text-align:left;">${this.escapeHtml(line.description)}</td>
          <td style="width:14%;padding:7px 10px;border-bottom:1px solid #9ca3af;text-align:right;white-space:nowrap;vertical-align:top;">${this.formatMoney(line.unitPrice)}</td>
          <td style="width:10%;padding:7px 10px;border-bottom:1px solid #9ca3af;text-align:right;white-space:nowrap;vertical-align:top;">${this.escapeHtml(String(line.quantity))}</td>
          <td style="width:18%;padding:7px 10px;border-bottom:1px solid #9ca3af;text-align:right;white-space:nowrap;vertical-align:top;">${this.formatMoney(line.lineTotal)}</td>
        </tr>`)
        .join('');

    const renderSection = (title: string, lines: InvoiceLineItem[]): string => {
      if (!lines.length) return '';
      return `<div style="display:block;width:100%;margin:18px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100% !important;border-collapse:collapse;table-layout:fixed;">
          <colgroup>
            <col style="width:58%;" />
            <col style="width:14%;" />
            <col style="width:10%;" />
            <col style="width:18%;" />
          </colgroup>
          <thead>
            <tr>
              <th align="center" colspan="4" bgcolor="#d1d5db" style="text-align:center !important;padding:10px 18px 16px !important;border:1px solid #8b8f94;font-size:15px;line-height:1.2;font-weight:700;color:#111827;">
                ${this.escapeHtml(title)}
              </th>
            </tr>
            <tr>
              <th align="left" bgcolor="#d1d5db" style="width:58%;text-align:left !important;padding:10px 16px !important;border-left:1px solid #8b8f94;border-right:1px solid #b5b9bf;border-bottom:1px solid #8b8f94;font-size:14px;line-height:1.2;font-weight:700;color:#111827;">Item Description</th>
              <th align="left" bgcolor="#d1d5db" style="width:14%;text-align:left !important;padding:10px 16px !important;border-right:1px solid #b5b9bf;border-bottom:1px solid #8b8f94;font-size:14px;line-height:1.2;font-weight:700;color:#111827;">Price</th>
              <th align="left" bgcolor="#d1d5db" style="width:10%;text-align:left !important;padding:10px 16px !important;border-right:1px solid #b5b9bf;border-bottom:1px solid #8b8f94;font-size:14px;line-height:1.2;font-weight:700;color:#111827;">Qty</th>
              <th align="left" bgcolor="#d1d5db" style="width:18%;text-align:left !important;padding:10px 16px !important;border-right:1px solid #8b8f94;border-bottom:1px solid #8b8f94;font-size:14px;line-height:1.2;font-weight:700;color:#111827;">Total</th>
            </tr>
          </thead>
          <tbody>${renderRows(lines)}</tbody>
        </table>
      </div>`;
    };

    return `<div style="display:block;width:100%;margin:20px 0;">${renderSection('Parts', parts)}${renderSection('Labor', labor)}</div>`;
  }

  private renderTotalsHtml(): string {
    if (!this.quoteLineItems().length) return '';
    return `<div style="display:block;width:100%;text-align:right;margin:10px 0 24px;">
    <table role="presentation" align="right" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;width:100%;max-width:380px;margin:0 0 0 auto;border-collapse:collapse;table-layout:fixed;">
      <tr>
        <td style="padding:6px 10px;border-top:1px solid #8b8f94;text-align:right;font-size:18px;line-height:1.2;font-weight:700;">Subtotal:</td>
        <td style="padding:6px 10px;border-top:1px solid #8b8f94;text-align:right;font-size:18px;line-height:1.2;">${this.formatMoney(this.quoteSubtotal())}</td>
      </tr>
      <tr>
        <td style="padding:6px 10px;border-top:1px solid #8b8f94;text-align:right;font-size:18px;line-height:1.2;font-weight:700;">Tax:</td>
        <td style="padding:6px 10px;border-top:1px solid #8b8f94;text-align:right;font-size:18px;line-height:1.2;">${this.formatMoney(this.quoteTaxTotal())}</td>
      </tr>
      <tr>
        <td bgcolor="#d1d5db" style="padding:7px 10px;border-top:1px solid #8b8f94;border-bottom:1px solid #8b8f94;text-align:right;font-size:18px;line-height:1.2;font-weight:800;">Total:</td>
        <td bgcolor="#d1d5db" style="padding:7px 10px;border-top:1px solid #8b8f94;border-bottom:1px solid #8b8f94;text-align:right;font-size:18px;line-height:1.2;font-weight:800;">${this.formatMoney(this.quoteGrandTotal())}</td>
      </tr>
    </table>
    </div>`;
  }

  private recalculateLine(line: InvoiceLineItem): InvoiceLineItem {
    const quantity = Math.max(0, this.safeNumber(line.quantity, 1));
    const unitPrice = Math.max(0, this.safeNumber(line.unitPrice, 0));
    const taxRate = Math.max(0, this.safeNumber(line.taxRate, 0));
    const lineSubtotal = this.roundCurrency(quantity * unitPrice);
    const taxAmount = this.roundCurrency((lineSubtotal * taxRate) / 100);
    const lineTotal = this.roundCurrency(lineSubtotal + taxAmount);
    return {
      ...line,
      type: line.type === 'labor' ? 'labor' : 'part',
      quantity,
      unitPrice,
      taxRate,
      lineSubtotal,
      taxAmount,
      lineTotal
    };
  }

  private safeNumber(value: unknown, fallback: number): number {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  private roundCurrency(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private formatMoney(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(this.roundCurrency(value));
  }

  private extractSendFailureReason(error: unknown): string {
    const candidate = error as {
      error?: { error?: string; message?: string; title?: string; detail?: string };
      message?: string;
      statusText?: string;
    };
    const raw =
      candidate?.error?.error ||
      candidate?.error?.message ||
      candidate?.error?.title ||
      candidate?.error?.detail ||
      candidate?.message ||
      candidate?.statusText ||
      '';
    const normalized = String(raw).trim();
    if (!normalized) return '';
    if (/verify|verified|verification/i.test(normalized)) return 'number not verified';
    if (/config|configured|from number|sender/i.test(normalized)) return 'sender not configured';
    if (/forbidden|unauthorized|401|403/i.test(normalized)) return 'not authorized';
    return normalized;
  }

  private normalizeTaxRate(value: unknown): number {
    const numeric = this.safeNumber(value, 0);
    if (numeric < 0) return 0;
    if (numeric > 100) return 100;
    return numeric;
  }

  private async loadEmailFooterTerms(): Promise<string> {
    try {
      const primary = await firstValueFrom(this.settingsApi.getValue<string>(EMAIL_FOOTER_TERMS_SETTING_KEY));
      const normalizedPrimary = String(primary || '').trim();
      if (normalizedPrimary) return normalizedPrimary;
      const legacy = await firstValueFrom(this.settingsApi.getValue<string>(LEGACY_QUOTE_TERMS_SETTING_KEY));
      return String(legacy || '').trim();
    } catch {
      return '';
    }
  }

  private deliverySelectionValid(): boolean {
    const hasEmail = this.sendEmail() && this.selectedEmailTargets().length > 0;
    const hasSms = this.sendSms() && this.selectedPhoneTargets().length > 0;
    return hasEmail || hasSms;
  }

  private formatAddressHtml(address: string): string {
    const text = String(address || '').trim();
    if (!text) return 'Address not set';
    return this.escapeHtml(text).replace(/\s*,\s*/g, '<br/>');
  }

  private todayIso(): string {
    return this.formatIsoDate(new Date());
  }

  private plusDaysIso(fromIso: string, days: number): string {
    const base = new Date(`${fromIso}T00:00:00`);
    if (!Number.isFinite(base.getTime())) return this.todayIso();
    const next = new Date(base.getTime());
    next.setDate(next.getDate() + Math.max(0, Math.floor(days)));
    return this.formatIsoDate(next);
  }

  private formatIsoDate(date: Date): string {
    const value = new Date(date.getTime());
    value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
    return value.toISOString().slice(0, 10);
  }

  private formatDisplayDate(isoDate: string): string {
    const value = String(isoDate || '').trim();
    if (!value) return '';
    const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
    if (!Number.isFinite(date.getTime())) return value;
    return new Intl.DateTimeFormat('en-US', {
      month: 'numeric',
      day: 'numeric',
      year: 'numeric'
    }).format(date);
  }

  private clearStatus(): void {
    this.status.set('');
    this.statusTone.set('neutral');
  }

  private setStatus(message: string, tone: StatusTone = 'neutral'): void {
    this.status.set(message);
    this.statusTone.set(tone);
    void this.presentStatusToast(message, tone);
  }

  private async presentStatusToast(message: string, tone: StatusTone): Promise<void> {
    const value = String(message || '').trim();
    if (!value) return;
    const key = `${tone}:${value}`.toLowerCase();
    const now = Date.now();
    if (this.lastToastKey === key && now - this.lastToastAt < 1200) return;
    this.lastToastKey = key;
    this.lastToastAt = now;

    const color = tone === 'error' ? 'danger' : tone === 'success' ? 'success' : 'medium';
    const toast = await this.toastController.create({
      message: value,
      color,
      duration: 1800,
      position: 'top'
    });
    await toast.present();
  }
}
