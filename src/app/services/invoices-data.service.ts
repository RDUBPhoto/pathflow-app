import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import { TenantContextService } from './tenant-context.service';
import { AuthService } from '../auth/auth.service';

export type InvoiceStage = 'draft' | 'sent' | 'accepted' | 'completed' | 'declined' | 'canceled' | 'expired';
export type InvoiceBoardStage = Exclude<InvoiceStage, 'expired' | 'canceled'> | 'completed';
export type InvoiceDocumentType = 'quote' | 'invoice';
export type InvoiceLineType = 'part' | 'labor';
export type InvoicePartStatus = 'out-of-stock' | 'in-stock' | 'ordered' | 'backordered' | 'received';

export type InvoiceCard = {
  id: string;
  documentType: InvoiceDocumentType;
  jobNumber?: string;
  customerId?: string;
  customerName: string;
  customerEmail?: string;
  invoiceNumber: string;
  invoicedAt: string;
  total: number;
  vehicle: string;
  vehicleId?: string;
  vehicleVin?: string;
  template: string;
  stage: InvoiceStage;
  isExpired: boolean;
};

export type InvoiceLane = {
  id: InvoiceBoardStage;
  title: string;
  color: string;
};

export type InvoiceLineItem = {
  id: string;
  type: InvoiceLineType;
  jobPartId?: string;
  relatedInventoryItemId?: string;
  partStatus?: InvoicePartStatus;
  trackingNumber?: string;
  code: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  lineSubtotal: number;
  taxAmount: number;
  lineTotal: number;
};

export type InvoiceTimelineActorType = 'system' | 'customer';

export type InvoiceTimelineEntry = {
  id: string;
  createdAt: string;
  message: string;
  createdBy?: string;
  createdById?: string;
  actorType?: InvoiceTimelineActorType;
};

export type InvoicePaymentTransaction = {
  id: string;
  provider: string;
  amount: number;
  transactionId: string;
  mode?: string;
  authCode?: string;
  accountType?: string;
  accountNumber?: string;
  createdAt: string;
};

export type InvoiceRefundTransaction = {
  id: string;
  provider: string;
  amount: number;
  transactionId: string;
  originalTransactionId: string;
  reason?: string;
  operation?: 'void' | 'refund';
  creditInvoice?: boolean;
  retainedFee?: number;
  createdAt: string;
};

export type InvoiceDetail = {
  id: string;
  sourceQuoteId?: string;
  documentType: InvoiceDocumentType;
  invoiceNumber: string;
  jobNumber?: string;
  stage: InvoiceStage;
  template: string;

  customerId?: string;
  customerName: string;
  customerEmail?: string;
  customerPhone?: string;
  customerAddress?: string;
  vehicle: string;
  vehicleId?: string;
  vehicleVin?: string;

  businessName: string;
  businessEmail?: string;
  businessPhone?: string;
  businessAddress?: string;
  businessLogoUrl?: string;

  description: string;
  flags: string;
  jobType: string;
  referralSource: string;
  staffNote: string;
  customerNote: string;

  issueDate: string;
  dueDate: string;
  paymentDate?: string;
  exportedDate?: string;

  includePaymentLink: boolean;
  paymentProviderKey?: string;
  paymentLinkUrl?: string;

  lineItems: InvoiceLineItem[];
  subtotal: number;
  taxTotal: number;
  total: number;
  paidAmount?: number;
  returnCreditAmount?: number;
  paymentTransactions?: InvoicePaymentTransaction[];
  refundTransactions?: InvoiceRefundTransaction[];

  createdAt: string;
  updatedAt: string;
  timeline: InvoiceTimelineEntry[];
};

type InvoiceCustomerLookup = {
  id?: string | null;
  email?: string | null;
  name?: string | null;
};

export type InvoiceDraftPayload = {
  documentType?: InvoiceDocumentType | null;
  sourceQuoteId?: string;
  jobNumber?: string | null;
  customerId?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  vehicle?: string | null;
  vehicleId?: string | null;
  vehicleVin?: string | null;

  businessName?: string | null;
  businessEmail?: string | null;
  businessPhone?: string | null;
  businessAddress?: string | null;
  businessLogoUrl?: string | null;

  template?: string | null;
  description?: string | null;
  flags?: string | null;
  jobType?: string | null;
  referralSource?: string | null;
  staffNote?: string | null;
  customerNote?: string | null;

  issueDate?: string | null;
  dueDate?: string | null;
  paymentDate?: string | null;
  exportedDate?: string | null;

  includePaymentLink?: boolean;
  paymentProviderKey?: string | null;
  paymentLinkUrl?: string | null;

  lineItems?: Array<Partial<InvoiceLineItem>> | null;
  paidAmount?: number | null;
  stage?: InvoiceStage | null;
};

export const INVOICE_LANES: InvoiceLane[] = [
  { id: 'draft', title: 'Drafts', color: '#ef4444' },
  { id: 'sent', title: 'Sent', color: '#14b8a6' },
  { id: 'accepted', title: 'Accepted', color: '#22c55e' },
  { id: 'declined', title: 'Declined', color: '#f59e0b' }
];

const MOCK_INVOICES: InvoiceDetail[] = [
  {
    id: 'inv-430501',
    documentType: 'quote',
    invoiceNumber: 'QTE-430501',
    stage: 'draft',
    template: 'Parts Invoice',
    customerId: '9f5337ab-3ca6-4f79-b3c6-cf7f9c7372fd',
    customerName: 'Robert Wojtow',
    customerEmail: 'RDUBPhoto@gmail.com',
    customerPhone: '(513) 678-9899',
    customerAddress: '3724 Forsyth Park, Schertz, TX 78154',
    vehicle: '2020 LINCOLN Navigator',
    businessName: 'Your Company',
    businessEmail: 'service@yourcompany.com',
    businessPhone: '(555) 555-0100',
    businessAddress: 'San Antonio, TX',
    businessLogoUrl: '',
    description: 'Initial estimate for parts + labor',
    flags: '',
    jobType: 'General Repair',
    referralSource: 'Website',
    staffNote: 'Awaiting customer approval',
    customerNote: 'Thank you for choosing us.',
    issueDate: '2026-02-20',
    dueDate: '2026-02-27',
    paymentDate: '',
    exportedDate: '',
    includePaymentLink: false,
    paymentProviderKey: '',
    paymentLinkUrl: '',
    lineItems: [
      {
        id: 'li-inv-430501-1',
        type: 'part',
        code: 'PART-120',
        description: 'Brake pad set',
        quantity: 1,
        unitPrice: 249.99,
        taxRate: 8.25,
        lineSubtotal: 249.99,
        taxAmount: 20.62,
        lineTotal: 270.61
      },
      {
        id: 'li-inv-430501-2',
        type: 'labor',
        code: 'LAB-42',
        description: 'Brake service labor',
        quantity: 3,
        unitPrice: 285.58,
        taxRate: 0,
        lineSubtotal: 856.74,
        taxAmount: 0,
        lineTotal: 856.74
      }
    ],
    subtotal: 1106.73,
    taxTotal: 20.62,
    total: 1127.35,
    createdAt: '2026-02-20T15:10:00.000Z',
    updatedAt: '2026-02-20T15:10:00.000Z',
    timeline: [
      {
        id: 'timeline-inv-430501-1',
        createdAt: '2026-02-20T15:10:00.000Z',
        message: 'Draft created.'
      }
    ]
  },
  {
    id: 'inv-430502',
    documentType: 'quote',
    invoiceNumber: 'QTE-430502',
    stage: 'draft',
    template: 'Labor only',
    customerId: 'f88e7547-d3e3-4722-a73e-f7f0adf95c8b',
    customerName: 'Avery Chen',
    customerEmail: 'avery@example.com',
    customerPhone: '(555) 991-1223',
    customerAddress: '',
    vehicle: '2021 Ford Bronco',
    businessName: 'Your Company',
    businessEmail: 'service@yourcompany.com',
    businessPhone: '(555) 555-0100',
    businessAddress: 'San Antonio, TX',
    businessLogoUrl: '',
    description: 'Labor-only estimate',
    flags: '',
    jobType: 'Labor',
    referralSource: 'Phone',
    staffNote: '',
    customerNote: '',
    issueDate: '2026-02-20',
    dueDate: '2026-02-27',
    paymentDate: '',
    exportedDate: '',
    includePaymentLink: false,
    paymentProviderKey: '',
    paymentLinkUrl: '',
    lineItems: [
      {
        id: 'li-inv-430502-1',
        type: 'labor',
        code: 'LAB-18',
        description: 'Diagnostic labor',
        quantity: 2,
        unitPrice: 196.25,
        taxRate: 0,
        lineSubtotal: 392.5,
        taxAmount: 0,
        lineTotal: 392.5
      }
    ],
    subtotal: 392.5,
    taxTotal: 0,
    total: 392.5,
    createdAt: '2026-02-20T16:00:00.000Z',
    updatedAt: '2026-02-20T16:00:00.000Z',
    timeline: [
      {
        id: 'timeline-inv-430502-1',
        createdAt: '2026-02-20T16:00:00.000Z',
        message: 'Draft created.'
      }
    ]
  },
  {
    id: 'inv-430478',
    documentType: 'quote',
    invoiceNumber: 'QTE-430478',
    stage: 'accepted',
    template: 'Alignment',
    customerName: 'Jordan Miles',
    customerEmail: 'jordan@example.com',
    customerPhone: '(555) 201-8841',
    customerAddress: '',
    vehicle: '2019 Jeep Wrangler',
    businessName: 'Your Company',
    businessEmail: 'service@yourcompany.com',
    businessPhone: '(555) 555-0100',
    businessAddress: 'San Antonio, TX',
    businessLogoUrl: '',
    description: 'Alignment service',
    flags: '',
    jobType: 'Alignment',
    referralSource: 'Walk-in',
    staffNote: '',
    customerNote: '',
    issueDate: '2026-02-19',
    dueDate: '2026-02-26',
    paymentDate: '',
    exportedDate: '',
    includePaymentLink: false,
    paymentProviderKey: '',
    paymentLinkUrl: '',
    lineItems: [
      {
        id: 'li-inv-430478-1',
        type: 'labor',
        code: 'ALIGN-01',
        description: '4-wheel alignment',
        quantity: 1,
        unitPrice: 86.25,
        taxRate: 0,
        lineSubtotal: 86.25,
        taxAmount: 0,
        lineTotal: 86.25
      }
    ],
    subtotal: 86.25,
    taxTotal: 0,
    total: 86.25,
    createdAt: '2026-02-19T13:00:00.000Z',
    updatedAt: '2026-02-19T13:00:00.000Z',
    timeline: [
      {
        id: 'timeline-inv-430478-1',
        createdAt: '2026-02-19T13:00:00.000Z',
        message: 'Invoice accepted.'
      }
    ]
  },
  {
    id: 'inv-430477',
    documentType: 'invoice',
    invoiceNumber: 'INV-430477',
    stage: 'sent',
    template: 'Parts Only',
    customerName: 'Sam Patel',
    customerEmail: 'sam@example.com',
    customerPhone: '(555) 303-4422',
    customerAddress: '',
    vehicle: '2017 Toyota 4Runner',
    businessName: 'Your Company',
    businessEmail: 'service@yourcompany.com',
    businessPhone: '(555) 555-0100',
    businessAddress: 'San Antonio, TX',
    businessLogoUrl: '',
    description: 'Parts invoice',
    flags: '',
    jobType: 'Parts',
    referralSource: 'Website',
    staffNote: '',
    customerNote: '',
    issueDate: '2026-02-18',
    dueDate: '2026-02-25',
    paymentDate: '',
    exportedDate: '',
    includePaymentLink: true,
    paymentProviderKey: 'authorize-net',
    paymentLinkUrl: 'https://pay.pathflow.com/authorize-net/checkout?invoiceId=inv-430477&invoice=INV-430477',
    lineItems: [
      {
        id: 'li-inv-430477-1',
        type: 'part',
        code: 'PART-200',
        description: 'Air filter kit',
        quantity: 2,
        unitPrice: 105.7,
        taxRate: 7.95,
        lineSubtotal: 211.4,
        taxAmount: 16.8,
        lineTotal: 228.2
      }
    ],
    subtotal: 211.4,
    taxTotal: 16.8,
    total: 228.2,
    createdAt: '2026-02-18T14:05:00.000Z',
    updatedAt: '2026-02-18T14:05:00.000Z',
    timeline: [
      {
        id: 'timeline-inv-430477-1',
        createdAt: '2026-02-18T14:05:00.000Z',
        message: 'Invoice sent to customer.'
      }
    ]
  },
  {
    id: 'inv-430476',
    documentType: 'invoice',
    invoiceNumber: 'INV-430476',
    stage: 'accepted',
    template: 'Parts Invoice',
    customerName: 'Casey Nguyen',
    customerEmail: 'casey@example.com',
    customerPhone: '(555) 884-2100',
    customerAddress: '',
    vehicle: '2022 Gladiator Rubicon',
    businessName: 'Your Company',
    businessEmail: 'service@yourcompany.com',
    businessPhone: '(555) 555-0100',
    businessAddress: 'San Antonio, TX',
    businessLogoUrl: '',
    description: 'Completed invoice',
    flags: '',
    jobType: 'Service',
    referralSource: 'Referral',
    staffNote: '',
    customerNote: '',
    issueDate: '2026-02-18',
    dueDate: '2026-02-25',
    paymentDate: '2026-02-19',
    exportedDate: '',
    includePaymentLink: true,
    paymentProviderKey: 'authorize-net',
    paymentLinkUrl: 'https://pay.pathflow.com/authorize-net/checkout?invoiceId=inv-430476&invoice=INV-430476',
    lineItems: [
      {
        id: 'li-inv-430476-1',
        type: 'part',
        code: 'PART-350',
        description: 'Suspension hardware',
        quantity: 4,
        unitPrice: 252,
        taxRate: 8.5,
        lineSubtotal: 1008,
        taxAmount: 85.68,
        lineTotal: 1093.68
      },
      {
        id: 'li-inv-430476-2',
        type: 'labor',
        code: 'LAB-90',
        description: 'Install labor',
        quantity: 2,
        unitPrice: 115.61,
        taxRate: 0,
        lineSubtotal: 231.22,
        taxAmount: 0,
        lineTotal: 231.22
      }
    ],
    subtotal: 1239.22,
    taxTotal: 85.68,
    total: 1324.9,
    createdAt: '2026-02-18T10:30:00.000Z',
    updatedAt: '2026-02-19T08:00:00.000Z',
    timeline: [
      {
        id: 'timeline-inv-430476-1',
        createdAt: '2026-02-18T10:30:00.000Z',
        message: 'Invoice sent to customer.'
      },
      {
        id: 'timeline-inv-430476-2',
        createdAt: '2026-02-19T08:00:00.000Z',
        message: 'Invoice accepted.'
      }
    ]
  },
  {
    id: 'inv-430454',
    documentType: 'quote',
    invoiceNumber: 'QTE-430454',
    stage: 'declined',
    template: 'Credit Memo',
    customerName: 'Morgan Lee',
    customerEmail: 'morgan@example.com',
    customerPhone: '(555) 771-9001',
    customerAddress: '',
    vehicle: '2020 Tacoma TRD',
    businessName: 'Your Company',
    businessEmail: 'service@yourcompany.com',
    businessPhone: '(555) 555-0100',
    businessAddress: 'San Antonio, TX',
    businessLogoUrl: '',
    description: 'Cancelled invoice',
    flags: '',
    jobType: 'Credit',
    referralSource: 'Phone',
    staffNote: '',
    customerNote: '',
    issueDate: '2026-02-12',
    dueDate: '2026-02-19',
    paymentDate: '',
    exportedDate: '',
    includePaymentLink: false,
    paymentProviderKey: '',
    paymentLinkUrl: '',
    lineItems: [
      {
        id: 'li-inv-430454-1',
        type: 'part',
        code: 'CR-10',
        description: 'Credit adjustment',
        quantity: 1,
        unitPrice: 159,
        taxRate: 0,
        lineSubtotal: 159,
        taxAmount: 0,
        lineTotal: 159
      }
    ],
    subtotal: 159,
    taxTotal: 0,
    total: 159,
    createdAt: '2026-02-12T09:00:00.000Z',
    updatedAt: '2026-02-12T11:00:00.000Z',
    timeline: [
      {
        id: 'timeline-inv-430454-1',
        createdAt: '2026-02-12T11:00:00.000Z',
        message: 'Invoice declined.'
      }
    ]
  }
];

const INVOICES_STORAGE_KEY_PREFIX = 'pathflow.invoices.v1';
type SharedDocument = { id: string; revision: string; document: InvoiceDetail | null };
type PendingDocument = { document: InvoiceDetail | null; revision: string | null; conflict?: boolean };
type DocumentSync = {
  resetVersion?: string;
  revisions: Record<string, string>;
  pending: Record<string, PendingDocument>;
  migrated: boolean;
};

@Injectable({ providedIn: 'root' })
export class InvoicesDataService {
  private readonly tenantContext = inject(TenantContextService);
  private readonly auth = inject(AuthService);
  private readonly http = inject(HttpClient, { optional: true });
  private readonly destroyRef = inject(DestroyRef);
  private readonly state = signal<InvoiceDetail[]>([]);
  private readonly syncing = new Set<string>();
  private readonly syncState = new Map<string, DocumentSync>();
  readonly documentSyncError = signal('');

  readonly invoiceDetails = computed(() => this.state().map(item => this.cloneInvoice(item)));
  readonly invoices = computed(() => this.state().map(item => this.toCard(item)));

  constructor() {
    effect(
      () => {
        const tenantId = this.storageTenantId();
        const loaded = this.loadFromStorage(tenantId);
        this.state.set(loaded);
        this.documentSyncError.set('');
      },
      { allowSignalWrites: true }
    );
    effect(onCleanup => {
      const tenantId = this.storageTenantId();
      if (!this.http || !this.auth.isAuthenticated?.()) return;
      untracked(() => void this.syncDocuments(tenantId));
      const timer = setInterval(() => void this.syncDocuments(tenantId), 15000);
      onCleanup(() => clearInterval(timer));
    });
    this.destroyRef.onDestroy(() => this.syncState.clear());
  }

  previewNextInvoiceNumber(documentType: InvoiceDocumentType = 'invoice'): string {
    return this.previewNextDocumentNumber(documentType);
  }

  previewNextDocumentNumber(documentType: InvoiceDocumentType = 'invoice'): string {
    const prefix = documentType === 'quote' ? 'QTE' : 'INV';
    return `${prefix}-${this.nextInvoiceSequence()}`;
  }

  previewNextJobNumber(): string {
    return this.formatJobNumber(this.nextJobSequence());
  }

  createDraftInvoice(payload: InvoiceDraftPayload = {}): InvoiceDetail {
    const sequence = this.nextInvoiceSequence();
    const nowIso = new Date().toISOString();
    const today = this.formatIsoDate(new Date());
    const documentType: InvoiceDocumentType = payload.documentType === 'quote' ? 'quote' : 'invoice';
    const numberPrefix = documentType === 'quote' ? 'QTE' : 'INV';
    const jobNumber = this.safeText(payload.jobNumber) || this.previewNextJobNumber();

    const invoice = this.normalizeInvoice({
      id: payload.sourceQuoteId ? `invoice-${payload.sourceQuoteId}` : this.generateDocumentId(),
      documentType,
      sourceQuoteId: payload.sourceQuoteId,
      invoiceNumber: `${numberPrefix}-${sequence}`,
      jobNumber,
      stage: payload.stage || 'draft',
      template: this.safeText(payload.template) || 'Other',

      customerId: this.safeText(payload.customerId) || '',
      customerName: this.safeText(payload.customerName) || 'Customer',
      customerEmail: this.safeText(payload.customerEmail) || '',
      customerPhone: this.safeText(payload.customerPhone) || '',
      customerAddress: this.safeText(payload.customerAddress) || '',
      vehicle: this.safeText(payload.vehicle) || 'Vehicle TBD',
      vehicleId: this.safeText(payload.vehicleId),
      vehicleVin: this.safeText(payload.vehicleVin),

      businessName: this.safeText(payload.businessName) || 'Shop',
      businessEmail: this.safeText(payload.businessEmail) || '',
      businessPhone: this.safeText(payload.businessPhone) || '',
      businessAddress: this.safeText(payload.businessAddress) || '',
      businessLogoUrl: this.safeText(payload.businessLogoUrl) || '',

      description: this.safeText(payload.description) || '',
      flags: this.safeText(payload.flags) || '',
      jobType: this.safeText(payload.jobType) || '',
      referralSource: this.safeText(payload.referralSource) || '',
      staffNote: this.safeText(payload.staffNote) || '',
      customerNote: this.safeText(payload.customerNote) || '',

      issueDate: this.safeText(payload.issueDate) || today,
      dueDate: this.safeText(payload.dueDate) || today,
      paymentDate: this.safeText(payload.paymentDate) || '',
      exportedDate: this.safeText(payload.exportedDate) || '',

      includePaymentLink: !!payload.includePaymentLink,
      paymentProviderKey: this.safeText(payload.paymentProviderKey) || '',
      paymentLinkUrl: this.safeText(payload.paymentLinkUrl) || '',

      lineItems: this.normalizeLineItems(payload.lineItems || []),
      subtotal: 0,
      taxTotal: 0,
      total: 0,
      paidAmount: this.safeNumber(payload.paidAmount, 0),
      paymentTransactions: [],
      refundTransactions: [],

      createdAt: nowIso,
      updatedAt: nowIso,
      timeline: [
        this.createTimelineEntry(
          `timeline-${sequence}-created`,
          nowIso,
          'Draft created.'
        )
      ]
    });

    this.updateState(current => [invoice, ...current]);
    return this.cloneInvoice(invoice);
  }

  getInvoiceById(id: string): InvoiceDetail | null {
    const key = String(id || '').trim();
    if (!key) return null;
    const lookup = key.toLowerCase();
    const all = this.state();
    const rankMatches = (matches: InvoiceDetail[]) =>
      matches.sort((a, b) => {
        const stageDiff = this.stageLookupPriority(b.stage) - this.stageLookupPriority(a.stage);
        if (stageDiff !== 0) return stageDiff;
        const updatedDiff = this.asMillis(b.updatedAt || b.createdAt || '') - this.asMillis(a.updatedAt || a.createdAt || '');
        if (updatedDiff !== 0) return updatedDiff;
        return this.asMillis(b.createdAt || '') - this.asMillis(a.createdAt || '');
      });

    const exactMatches = rankMatches(all.filter(invoice => String(invoice.id || '').trim() === key));
    const numberMatches = rankMatches(
      all.filter(invoice => String(invoice.invoiceNumber || '').trim().toLowerCase() === lookup)
    );

    if (this.looksLikeDocumentNumber(key) && numberMatches.length) {
      return this.cloneInvoice(numberMatches[0]);
    }
    if (exactMatches.length) return this.cloneInvoice(exactMatches[0]);
    return numberMatches.length ? this.cloneInvoice(numberMatches[0]) : null;
  }

  saveInvoice(invoice: InvoiceDetail): InvoiceDetail {
    const incoming = this.cloneInvoice(invoice);
    const nowIso = new Date().toISOString();

    this.updateState(current => {
      const incomingId = this.safeText(incoming.id);
      const incomingNumber = this.normalize(incoming.invoiceNumber);
      let index = current.findIndex(item => item.id === incomingId);
      if (index === -1 && incomingNumber) {
        index = current.findIndex(item => this.normalize(item.invoiceNumber) === incomingNumber);
      }
      if (index === -1) {
        const created = this.normalizeInvoice({
          ...incoming,
          id: incomingId || this.generateDocumentId(),
          invoiceNumber: incoming.invoiceNumber || this.previewNextDocumentNumber(incoming.documentType),
          jobNumber: this.safeText(incoming.jobNumber) || this.previewNextJobNumber(),
          createdAt: incoming.createdAt || nowIso,
          updatedAt: nowIso
        });
        const next = this.reconcileQuoteSiblings([created, ...current], created, nowIso);
        return next;
      }

      const existing = current[index];
      const previousStage = existing.stage;
      const nextStage = incoming.stage;
      const timeline = this.mergeTimeline(existing.timeline, incoming.timeline);
      if (previousStage !== nextStage) {
        timeline.push(this.createTimelineEntry(
          `timeline-${incoming.id}-${Date.now()}`,
          nowIso,
          this.stageTransitionMessage(previousStage, nextStage)
        ));
      }

      const merged = this.normalizeInvoice({
        ...existing,
        ...incoming,
        id: existing.id,
        invoiceNumber: existing.invoiceNumber || incoming.invoiceNumber,
        jobNumber: this.safeText(existing.jobNumber) || this.safeText(incoming.jobNumber) || this.previewNextJobNumber(),
        createdAt: existing.createdAt || incoming.createdAt || nowIso,
        updatedAt: nowIso,
        timeline
      });

      const next = [...current];
      next[index] = merged;
      return this.reconcileQuoteSiblings(next, merged, nowIso);
    });

    return this.getInvoiceById(incoming.id || incoming.invoiceNumber) || this.cloneInvoice(this.normalizeInvoice(incoming));
  }

  setStage(id: string, stage: InvoiceStage, note?: string, actorType?: InvoiceTimelineActorType): InvoiceDetail | null {
    const key = String(id || '').trim();
    if (!key) return null;

    const nowIso = new Date().toISOString();
    let updated: InvoiceDetail | null = null;

    this.updateState(current => {
      const index = current.findIndex(item => item.id === key);
      if (index === -1) return current;

      const existing = current[index];
      const timeline = [...existing.timeline];
      timeline.push(this.createTimelineEntry(
        `timeline-${key}-${Date.now()}`,
        nowIso,
        note?.trim() || this.stageTransitionMessage(existing.stage, stage),
        actorType
      ));

      const normalizedPaidAmount = (stage === 'accepted' || stage === 'completed') && existing.documentType === 'invoice'
        ? this.roundCurrency(Math.max(0, Number(existing.total || 0)))
        : this.roundCurrency(Math.max(0, Number((existing as any).paidAmount || 0)));

      const nextInvoice = this.normalizeInvoice({
        ...existing,
        stage,
        paidAmount: normalizedPaidAmount,
        paymentDate: stage === 'accepted' || stage === 'completed'
          ? (this.safeText(existing.paymentDate) || this.formatIsoDate(new Date()))
          : this.safeText(existing.paymentDate),
        updatedAt: nowIso,
        timeline
      });

      const next = [...current];
      next[index] = nextInvoice;
      updated = this.cloneInvoice(nextInvoice);
      return next;
    });

    return updated;
  }

  setPaidAmount(id: string, paidAmount: number, note?: string, actorType?: InvoiceTimelineActorType): InvoiceDetail | null {
    const key = String(id || '').trim();
    if (!key) return null;

    const nowIso = new Date().toISOString();
    let updated: InvoiceDetail | null = null;

    this.updateState(current => {
      const index = current.findIndex(item => item.id === key);
      if (index === -1) return current;

      const existing = current[index];
      const normalizedPaidAmount = this.roundCurrency(Math.max(0, Number.isFinite(Number(paidAmount)) ? Number(paidAmount) : 0));
      const previousStage = existing.stage;
      const nextStage = this.resolveStageFromBalance(existing, normalizedPaidAmount);
      const timeline = [...existing.timeline];
      timeline.push(this.createTimelineEntry(
        `timeline-${key}-${Date.now()}`,
        nowIso,
        note?.trim() || `Payment applied: ${this.formatCurrency(normalizedPaidAmount)}.`,
        actorType
      ));
      if (previousStage !== nextStage) {
        timeline.push(this.createTimelineEntry(
          `timeline-${key}-${Date.now()}-stage`,
          nowIso,
          this.stageTransitionMessage(previousStage, nextStage),
          actorType
        ));
      }

      const nextInvoice = this.normalizeInvoice({
        ...existing,
        stage: nextStage,
        paidAmount: normalizedPaidAmount,
        paymentDate: nextStage === 'accepted' ? this.safeText(existing.paymentDate) || this.formatIsoDate(new Date()) : '',
        updatedAt: nowIso,
        timeline
      });

      const next = [...current];
      next[index] = nextInvoice;
      updated = this.cloneInvoice(nextInvoice);
      return next;
    });

    return updated;
  }

  recordPaymentTransaction(
    id: string,
    payment: {
      provider: string;
      amount: number;
      transactionId: string;
      mode?: string;
      authCode?: string;
      accountType?: string;
      accountNumber?: string;
      createdAt?: string;
    }
  ): InvoiceDetail | null {
    const key = String(id || '').trim();
    if (!key) return null;

    const provider = this.safeText(payment.provider).toLowerCase();
    const transactionId = this.safeText(payment.transactionId);
    const amount = this.roundCurrency(Math.max(0, Number.isFinite(Number(payment.amount)) ? Number(payment.amount) : 0));
    if (!provider || !transactionId || amount <= 0) return null;

    const nowIso = this.safeText(payment.createdAt) || new Date().toISOString();
    let updated: InvoiceDetail | null = null;

    this.updateState(current => {
      const index = current.findIndex(item => item.id === key);
      if (index === -1) return current;

      const existing = current[index];
      const nextTransactions = [...(existing.paymentTransactions || [])];
      const dedupeKey = `${provider}|${transactionId}`.toLowerCase();
      const existingIndex = nextTransactions.findIndex(item =>
        `${this.safeText(item.provider).toLowerCase()}|${this.safeText(item.transactionId)}`.toLowerCase() === dedupeKey
      );

      const normalizedEntry: InvoicePaymentTransaction = {
        id: existingIndex >= 0
          ? nextTransactions[existingIndex].id
          : `payment-${key}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        provider,
        amount,
        transactionId,
        mode: this.safeText(payment.mode),
        authCode: this.safeText(payment.authCode),
        accountType: this.safeText(payment.accountType),
        accountNumber: this.safeText(payment.accountNumber),
        createdAt: nowIso
      };

      if (existingIndex >= 0) {
        nextTransactions[existingIndex] = normalizedEntry;
      } else {
        nextTransactions.push(normalizedEntry);
      }

      const nextInvoice = this.normalizeInvoice({
        ...existing,
        paymentTransactions: nextTransactions,
        updatedAt: new Date().toISOString()
      });

      const next = [...current];
      next[index] = nextInvoice;
      updated = this.cloneInvoice(nextInvoice);
      return next;
    });

    return updated;
  }

  recordProcessorRefund(
    id: string,
    refund: {
      provider: string;
      amount: number;
      transactionId: string;
      originalTransactionId: string;
      reason?: string;
      createdAt?: string;
      operation?: 'void' | 'refund';
      id?: string;
      paidAmount?: number;
      returnCreditAmount?: number;
      creditInvoice?: boolean;
      retainedFee?: number;
    }
  ): InvoiceDetail | null {
    const key = String(id || '').trim();
    if (!key) return null;

    const provider = this.safeText(refund.provider).toLowerCase();
    const transactionId = this.safeText(refund.transactionId);
    const originalTransactionId = this.safeText(refund.originalTransactionId);
    const amount = this.roundCurrency(Math.max(0, Number.isFinite(Number(refund.amount)) ? Number(refund.amount) : 0));
    if (!provider || !transactionId || !originalTransactionId || amount <= 0) return null;

    const createdAt = this.safeText(refund.createdAt) || new Date().toISOString();
    let updated: InvoiceDetail | null = null;

    this.updateState(current => {
      const index = current.findIndex(item => item.id === key);
      if (index === -1) return current;

      const existing = current[index];
      const nextRefunds = [...(existing.refundTransactions || [])];
      if (nextRefunds.some(item => item.provider === provider && item.transactionId === transactionId)) {
        updated = this.cloneInvoice(existing);
        return current;
      }
      const previousStage = existing.stage;
      const currentPaid = this.roundCurrency(Math.max(0, Number(existing.paidAmount || 0)));
      const nextPaid = this.roundCurrency(Math.max(0, refund.paidAmount ?? currentPaid - amount));
      const returnCreditAmount = refund.returnCreditAmount ?? existing.returnCreditAmount ?? 0;
      const nextTotal = existing.total + (existing.returnCreditAmount || 0) - returnCreditAmount;
      const nextStage = this.resolveStageFromBalance({ ...existing, total: nextTotal }, nextPaid);

      const amountLabel = this.formatCurrency(amount);
      const reason = this.safeText(refund.reason);
      const timeline = [...existing.timeline];
      const refundId = refund.id || `refund-${key}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const action = refund.operation === 'void' ? 'Payment voided' : 'Refund issued';
      const history = [`${action} for ${amountLabel}.`, refund.creditInvoice ? 'Invoice credited.' : '',
        refund.retainedFee ? `Fee retained ${this.formatCurrency(refund.retainedFee)}.` : '', reason].filter(Boolean).join(' ');
      timeline.push(this.createTimelineEntry(
        refundId,
        createdAt,
        history,
        'system'
      ));
      if (previousStage !== nextStage) {
        timeline.push(this.createTimelineEntry(
          `timeline-${key}-${Date.now()}-refund-stage`,
          createdAt,
          this.stageTransitionMessage(previousStage, nextStage)
        ));
      }

      nextRefunds.push({
        id: refundId,
        provider,
        amount,
        transactionId,
        originalTransactionId,
        reason,
        operation: refund.operation,
        creditInvoice: refund.creditInvoice,
        retainedFee: refund.retainedFee,
        createdAt
      });

      const nextInvoice = this.normalizeInvoice({
        ...existing,
        stage: nextStage,
        paidAmount: nextPaid,
        returnCreditAmount,
        paymentDate: nextStage === 'accepted' ? this.safeText(existing.paymentDate) || this.formatIsoDate(new Date()) : '',
        refundTransactions: nextRefunds,
        updatedAt: new Date().toISOString(),
        timeline
      });

      const next = [...current];
      next[index] = nextInvoice;
      updated = this.cloneInvoice(nextInvoice);
      return next;
    }, provider !== 'paylynx');

    return updated;
  }

  recordRefund(id: string, amount: number, note?: string): InvoiceDetail | null {
    const key = String(id || '').trim();
    if (!key) return null;

    const normalizedAmount = this.roundCurrency(Math.max(0, Number.isFinite(Number(amount)) ? Number(amount) : 0));
    if (!normalizedAmount) return null;

    const nowIso = new Date().toISOString();
    let updated: InvoiceDetail | null = null;

    this.updateState(current => {
      const index = current.findIndex(item => item.id === key);
      if (index === -1) return current;

      const existing = current[index];
      const previousStage = existing.stage;
      const currentPaid = this.roundCurrency(Math.max(0, Number(existing.paidAmount || 0)));
      const nextPaid = this.roundCurrency(Math.max(0, currentPaid - normalizedAmount));
      const nextStage = this.resolveStageFromBalance(existing, nextPaid);
      const timeline = [...existing.timeline];
      const amountLabel = this.formatCurrency(normalizedAmount);
      const detail = String(note || '').trim();
      timeline.push(this.createTimelineEntry(
        `timeline-${key}-${Date.now()}-refund`,
        nowIso,
        detail ? `Refund issued: ${amountLabel}. ${detail}` : `Refund issued: ${amountLabel}.`
      ));
      if (previousStage !== nextStage) {
        timeline.push(this.createTimelineEntry(
          `timeline-${key}-${Date.now()}-refund-stage`,
          nowIso,
          this.stageTransitionMessage(previousStage, nextStage)
        ));
      }

      const nextInvoice = this.normalizeInvoice({
        ...existing,
        stage: nextStage,
        paidAmount: nextPaid,
        paymentDate: nextStage === 'accepted' ? this.safeText(existing.paymentDate) || this.formatIsoDate(new Date()) : '',
        updatedAt: nowIso,
        timeline
      });

      const next = [...current];
      next[index] = nextInvoice;
      updated = this.cloneInvoice(nextInvoice);
      return next;
    });

    return updated;
  }

  forCustomer(lookup: InvoiceCustomerLookup): InvoiceCard[] {
    const id = this.normalize(lookup.id);
    const email = this.normalize(lookup.email);
    const name = this.normalize(lookup.name);

    if (!id && !email && !name) return [];

    return this.invoices().filter(invoice => {
      const invoiceId = this.normalize(invoice.customerId);
      const invoiceEmail = this.normalize(invoice.customerEmail);
      const invoiceName = this.normalize(invoice.customerName);

      if (id && invoiceId && id === invoiceId) return true;
      if (email && invoiceEmail && email === invoiceEmail) return true;
      if (name && invoiceName && name === invoiceName) return true;
      return false;
    });
  }

  cancelForCustomer(lookup: InvoiceCustomerLookup, note = 'Removed from dashboard workflow.'): number {
    const id = this.normalize(lookup.id);
    const email = this.normalize(lookup.email);
    const name = this.normalize(lookup.name);
    if (!id && !email && !name) return 0;

    let changed = 0;
    const nowIso = new Date().toISOString();
    this.updateState(current => current.map(invoice => {
      const invoiceId = this.normalize(invoice.customerId);
      const invoiceEmail = this.normalize(invoice.customerEmail);
      const invoiceName = this.normalize(invoice.customerName);
      const matches =
        (id && invoiceId && id === invoiceId)
        || (email && invoiceEmail && email === invoiceEmail)
        || (name && invoiceName && name === invoiceName);
      if (!matches) return invoice;
      if (invoice.documentType === 'invoice' && invoice.stage === 'accepted') return invoice;
      if (invoice.stage === 'canceled' || invoice.stage === 'expired') return invoice;

      changed += 1;
      const timeline = [...invoice.timeline, this.createTimelineEntry(
        `timeline-${invoice.id}-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        nowIso,
        note
      )];
      return this.normalizeInvoice({
        ...invoice,
        stage: 'canceled',
        updatedAt: nowIso,
        timeline
      });
    }));

    return changed;
  }

  invoicesByType(documentType: InvoiceDocumentType): InvoiceCard[] {
    return this.invoices().filter(invoice => invoice.documentType === documentType);
  }

  hasCustomerFacingEmailHistory(invoice: Pick<InvoiceDetail, 'documentType' | 'timeline'> | null | undefined): boolean {
    if (!invoice) return false;
    const documentType = invoice.documentType === 'quote' ? 'quote' : 'invoice';
    const timeline = Array.isArray(invoice.timeline) ? invoice.timeline : [];
    return timeline.some(entry => this.isCustomerFacingEmailTimelineMessage(entry?.message, documentType));
  }

  createInvoiceFromQuote(quoteId: string): InvoiceDetail | null {
    const quote = this.getInvoiceById(quoteId);
    if (!quote || quote.documentType !== 'quote' || quote.stage !== 'accepted') return null;

    const existing = this.getInvoiceById(`invoice-${quote.id}`);
    if (existing) return existing;
    return this.createDraftInvoice({
      documentType: 'invoice',
      sourceQuoteId: quote.id,
      jobNumber: quote.jobNumber,
      customerId: quote.customerId,
      customerName: quote.customerName,
      customerEmail: quote.customerEmail,
      customerPhone: quote.customerPhone,
      customerAddress: quote.customerAddress,
      vehicle: quote.vehicle,
      vehicleId: quote.vehicleId,
      vehicleVin: quote.vehicleVin,
      businessName: quote.businessName,
      businessEmail: quote.businessEmail,
      businessPhone: quote.businessPhone,
      businessAddress: quote.businessAddress,
      businessLogoUrl: quote.businessLogoUrl,
      template: quote.template,
      description: quote.description,
      flags: quote.flags,
      jobType: quote.jobType,
      referralSource: quote.referralSource,
      staffNote: quote.staffNote,
      customerNote: quote.customerNote,
      lineItems: quote.lineItems.map(item => ({ ...item })),
      includePaymentLink: true,
      stage: 'draft',
      paidAmount: 0
    });

  }

  deleteDraftQuote(id: string): boolean {
    return this.deleteDraftDocument(id);
  }

  deleteDraftDocument(id: string): boolean {
    const key = String(id || '').trim();
    if (!key) return false;

    let removed = false;
    this.updateState(current => {
      const next = current.filter(item => {
        const isMatch = item.id === key;
        const isDraftDocument = item.stage === 'draft';
        if (isMatch && isDraftDocument) {
          removed = true;
          return false;
        }
        return true;
      });
      return next;
    });

    return removed;
  }

  isExpiredQuote(invoice: Pick<InvoiceDetail, 'documentType' | 'stage' | 'updatedAt' | 'issueDate'>): boolean {
    if (invoice.documentType !== 'quote') return false;
    if (invoice.stage !== 'declined') return false;
    const basis = String(invoice.updatedAt || invoice.issueDate || '').trim();
    const basisMs = Date.parse(basis);
    if (!Number.isFinite(basisMs)) return false;
    const ageMs = Date.now() - basisMs;
    return ageMs >= 30 * 24 * 60 * 60 * 1000;
  }

  private safeText(value: unknown): string {
    return String(value || '').trim();
  }

  private normalize(value: string | null | undefined): string {
    return String(value || '').trim().toLowerCase();
  }

  private asMillis(value: string | null | undefined): number {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private looksLikeDocumentNumber(value: string): boolean {
    const normalized = String(value || '').trim().toUpperCase();
    return /^(QTE|INV)-\d+$/.test(normalized);
  }

  private stageLookupPriority(stage: InvoiceStage): number {
    if (stage === 'completed') return 7;
    if (stage === 'accepted') return 6;
    if (stage === 'sent') return 5;
    if (stage === 'draft') return 4;
    if (stage === 'declined') return 3;
    if (stage === 'expired') return 2;
    if (stage === 'canceled') return 1;
    return 0;
  }

  private toCard(invoice: InvoiceDetail): InvoiceCard {
    return {
      id: invoice.id,
      documentType: invoice.documentType,
      jobNumber: this.safeText(invoice.jobNumber) || undefined,
      customerId: this.safeText(invoice.customerId) || undefined,
      customerName: invoice.customerName,
      customerEmail: this.safeText(invoice.customerEmail) || undefined,
      invoiceNumber: invoice.invoiceNumber,
      invoicedAt: this.formatInvoiceDate(invoice.issueDate || invoice.createdAt),
      total: this.roundCurrency(invoice.total),
      vehicle: this.safeText(invoice.vehicle) || 'Vehicle TBD',
      vehicleId: this.safeText(invoice.vehicleId),
      vehicleVin: this.safeText(invoice.vehicleVin),
      template: this.safeText(invoice.template) || 'Other',
      stage: invoice.stage,
      isExpired: this.isExpiredQuote(invoice)
    };
  }

  private normalizeInvoice(invoice: InvoiceDetail): InvoiceDetail {
    const lineItems = this.normalizeLineItems(invoice.lineItems || []);
    const subtotal = this.roundCurrency(lineItems.reduce((sum, line) => sum + line.lineSubtotal, 0));
    const taxTotal = this.roundCurrency(lineItems.reduce((sum, line) => sum + line.taxAmount, 0));
    const normalizedDocumentType: InvoiceDocumentType = invoice.documentType === 'quote' ? 'quote' : 'invoice';
    const returnCreditAmount = normalizedDocumentType === 'invoice'
      ? Math.max(0, this.safeNumber(invoice.returnCreditAmount, 0)) : 0;
    const total = this.roundCurrency(Math.max(0, subtotal + taxTotal - returnCreditAmount));
    const requestedStage = this.normalizeStage(invoice.stage);
    const rawPaidAmount = Number((invoice as any).paidAmount);
    const hasExplicitPaidAmount = Number.isFinite(rawPaidAmount);
    let paidAmount = this.roundCurrency(Math.max(0, this.safeNumber((invoice as any).paidAmount, 0)));
    if (normalizedDocumentType === 'invoice' && requestedStage === 'accepted' && !hasExplicitPaidAmount) {
      // Backfill legacy paid invoices that had stage but no paidAmount persisted.
      paidAmount = total;
    }
    const paymentTransactions = this.normalizePaymentTransactions((invoice as any).paymentTransactions || []);
    const refundTransactions = this.normalizeRefundTransactions((invoice as any).refundTransactions || []);
    const normalizedStage = this.resolveStageFromBalance(
      {
        ...invoice,
        documentType: normalizedDocumentType,
        stage: requestedStage,
        total
      },
      paidAmount
    );

    return {
      ...invoice,
      documentType: normalizedDocumentType,
      jobNumber: this.safeText((invoice as any).jobNumber),
      stage: normalizedStage,
      customerId: this.safeText(invoice.customerId),
      customerName: this.safeText(invoice.customerName) || 'Customer',
      customerEmail: this.safeText(invoice.customerEmail),
      customerPhone: this.safeText(invoice.customerPhone),
      customerAddress: this.safeText(invoice.customerAddress),
      vehicle: this.safeText(invoice.vehicle) || 'Vehicle TBD',
      vehicleId: this.safeText(invoice.vehicleId),
      vehicleVin: this.safeText(invoice.vehicleVin),
      businessName: this.safeText(invoice.businessName) || 'Shop',
      businessEmail: this.safeText(invoice.businessEmail),
      businessPhone: this.safeText(invoice.businessPhone),
      businessAddress: this.safeText(invoice.businessAddress),
      businessLogoUrl: this.safeText(invoice.businessLogoUrl),
      description: this.safeText(invoice.description),
      flags: this.safeText(invoice.flags),
      jobType: this.safeText(invoice.jobType),
      referralSource: this.safeText(invoice.referralSource),
      staffNote: this.safeText(invoice.staffNote),
      customerNote: this.safeText(invoice.customerNote),
      issueDate: this.safeText(invoice.issueDate) || this.formatIsoDate(new Date()),
      dueDate: this.safeText(invoice.dueDate) || this.formatIsoDate(new Date()),
      exportedDate: this.safeText(invoice.exportedDate),
      includePaymentLink: !!invoice.includePaymentLink,
      paymentProviderKey: this.safeText(invoice.paymentProviderKey),
      paymentLinkUrl: this.safeText(invoice.paymentLinkUrl),
      lineItems,
      subtotal,
      taxTotal,
      total,
      returnCreditAmount,
      paidAmount,
      paymentTransactions,
      refundTransactions,
      paymentDate: normalizedStage === 'accepted' ? this.safeText(invoice.paymentDate) : '',
      createdAt: this.safeText(invoice.createdAt) || new Date().toISOString(),
      updatedAt: this.safeText(invoice.updatedAt) || new Date().toISOString(),
      timeline: this.normalizeTimeline(invoice.timeline || [])
    };
  }

  private resolveStageFromBalance(invoice: Pick<InvoiceDetail, 'documentType' | 'stage' | 'total'>, paidAmount: number): InvoiceStage {
    const currentStage = this.normalizeStage(invoice.stage);
    if (invoice.documentType !== 'invoice') return currentStage;
    if (currentStage !== 'sent' && currentStage !== 'accepted' && currentStage !== 'completed') return currentStage;
    const total = this.roundCurrency(Math.max(0, this.safeNumber(invoice.total, 0)));
    const due = this.roundCurrency(Math.max(0, total - Math.max(0, paidAmount)));
    if (due <= 0) return currentStage === 'completed' ? 'completed' : 'accepted';
    return 'sent';
  }

  private normalizeStage(value: unknown): InvoiceStage {
    const stage = String(value || '').trim().toLowerCase();
    if (stage === 'draft' || stage === 'drafts') return 'draft';
    if (stage === 'sent') return 'sent';
    if (stage === 'accepted' || stage === 'paid') return 'accepted';
    if (stage === 'completed' || stage === 'complete') return 'completed';
    if (stage === 'declined') return 'declined';
    if (stage === 'canceled' || stage === 'cancelled') return 'canceled';
    if (stage === 'expired') return 'expired';
    return 'draft';
  }

  private normalizeLineItems(items: Array<Partial<InvoiceLineItem>>): InvoiceLineItem[] {
    return (Array.isArray(items) ? items : []).map((line, index) => {
      const quantity = this.safeNumber(line.quantity, 1);
      const unitPrice = this.safeNumber(line.unitPrice, 0);
      const taxRate = this.safeNumber(line.taxRate, 0);
      const lineSubtotal = this.roundCurrency(quantity * unitPrice);
      const taxAmount = this.roundCurrency((lineSubtotal * taxRate) / 100);
      const lineTotal = this.roundCurrency(lineSubtotal + taxAmount);
      const type: InvoiceLineType = line.type === 'labor' ? 'labor' : 'part';
      return {
        id: this.safeText(line.id) || `li-${Date.now()}-${index}`,
        type,
        jobPartId: type === 'part' ? this.safeText((line as Partial<InvoiceLineItem>).jobPartId) : '',
        relatedInventoryItemId: type === 'part' ? this.safeText((line as Partial<InvoiceLineItem>).relatedInventoryItemId) : '',
        partStatus: type === 'part' ? this.normalizePartStatus(line.partStatus) : undefined,
        trackingNumber: type === 'part' ? this.safeText((line as Partial<InvoiceLineItem>).trackingNumber) : '',
        code: this.safeText(line.code),
        description: this.safeText(line.description),
        quantity,
        unitPrice,
        taxRate,
        lineSubtotal,
        taxAmount,
        lineTotal
      };
    });
  }

  private normalizePartStatus(value: unknown): InvoicePartStatus {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'out-of-stock' || normalized === 'out of stock' || normalized === 'outofstock') return 'out-of-stock';
    if (normalized === 'in-stock' || normalized === 'in stock' || normalized === 'instock') return 'in-stock';
    if (normalized === 'ordered' || normalized === 'on-order' || normalized === 'on order') return 'ordered';
    if (normalized === 'backordered' || normalized === 'back-order' || normalized === 'back order') return 'backordered';
    if (normalized === 'received' || normalized === 'invoiced-received') return 'received';
    return 'out-of-stock';
  }

  private normalizeTimeline(items: InvoiceTimelineEntry[]): InvoiceTimelineEntry[] {
    const source = Array.isArray(items) ? items : [];
    const normalized = source
      .map((entry, index) => ({
        id: this.safeText(entry.id) || `timeline-${Date.now()}-${index}`,
        createdAt: this.safeText(entry.createdAt) || new Date().toISOString(),
        message: this.safeText(entry.message),
        createdBy: this.safeText(entry.createdBy),
        createdById: this.safeText(entry.createdById),
        actorType: this.normalizeTimelineActorType(entry.actorType, this.safeText(entry.message))
      }))
      .filter(entry => !!entry.message);

    return normalized.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  private normalizePaymentTransactions(items: InvoicePaymentTransaction[]): InvoicePaymentTransaction[] {
    const source = Array.isArray(items) ? items : [];
    const dedupe = new Map<string, InvoicePaymentTransaction>();
    for (let index = 0; index < source.length; index += 1) {
      const row = source[index];
      const provider = this.safeText(row?.provider).toLowerCase();
      const transactionId = this.safeText(row?.transactionId);
      const amount = this.roundCurrency(Math.max(0, Number.isFinite(Number(row?.amount)) ? Number(row?.amount) : 0));
      if (!provider || !transactionId || amount <= 0) continue;
      const createdAt = this.safeText(row?.createdAt) || new Date().toISOString();
      const entry: InvoicePaymentTransaction = {
        id: this.safeText(row?.id) || `payment-${Date.now()}-${index}`,
        provider,
        amount,
        transactionId,
        mode: this.safeText(row?.mode),
        authCode: this.safeText(row?.authCode),
        accountType: this.safeText(row?.accountType),
        accountNumber: this.safeText(row?.accountNumber),
        createdAt
      };
      dedupe.set(`${provider}|${transactionId}`.toLowerCase(), entry);
    }
    return Array.from(dedupe.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  private normalizeRefundTransactions(items: InvoiceRefundTransaction[]): InvoiceRefundTransaction[] {
    const source = Array.isArray(items) ? items : [];
    const dedupe = new Map<string, InvoiceRefundTransaction>();
    for (let index = 0; index < source.length; index += 1) {
      const row = source[index];
      const provider = this.safeText(row?.provider).toLowerCase();
      const transactionId = this.safeText(row?.transactionId);
      const originalTransactionId = this.safeText(row?.originalTransactionId);
      const amount = this.roundCurrency(Math.max(0, Number.isFinite(Number(row?.amount)) ? Number(row?.amount) : 0));
      if (!provider || !transactionId || !originalTransactionId || amount <= 0) continue;
      const createdAt = this.safeText(row?.createdAt) || new Date().toISOString();
      const entry: InvoiceRefundTransaction = {
        id: this.safeText(row?.id) || `refund-${Date.now()}-${index}`,
        provider,
        amount,
        transactionId,
        originalTransactionId,
        reason: this.safeText(row?.reason),
        operation: row?.operation === 'void' || row?.operation === 'refund' ? row.operation : undefined,
        creditInvoice: row?.creditInvoice === true,
        retainedFee: this.roundCurrency(Math.max(0, this.safeNumber(row?.retainedFee, 0))),
        createdAt
      };
      dedupe.set(`${provider}|${transactionId}`.toLowerCase(), entry);
    }
    return Array.from(dedupe.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  private mergeTimeline(existing: InvoiceTimelineEntry[], incoming: InvoiceTimelineEntry[]): InvoiceTimelineEntry[] {
    const map = new Map<string, InvoiceTimelineEntry>();
    for (const entry of this.normalizeTimeline(existing)) {
      map.set(entry.id, entry);
    }
    for (const entry of this.normalizeTimeline(incoming)) {
      map.set(entry.id, entry);
    }
    return Array.from(map.values()).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  private normalizeTimelineActorType(value: unknown, message: string): InvoiceTimelineActorType {
    const raw = this.safeText(value).toLowerCase();
    if (raw === 'customer') return 'customer';
    if (raw === 'system') return 'system';
    return this.inferTimelineActorType(message);
  }

  private inferTimelineActorType(message: string): InvoiceTimelineActorType {
    const text = this.safeText(message).toLowerCase();
    const looksCustomerAction =
      text.includes('customer accepted')
      || text.includes('customer declined')
      || text.includes('customer paid')
      || text.includes('from public link');
    return looksCustomerAction ? 'customer' : 'system';
  }

  private currentActor(): { id: string; name: string } {
    const user = this.auth.user();
    const id = this.safeText(user?.id) || this.safeText(user?.email);
    const name = this.safeText(user?.displayName) || this.safeText(user?.email) || 'Staff';
    return { id, name };
  }

  private createTimelineEntry(
    id: string,
    createdAt: string,
    message: string,
    actorType?: InvoiceTimelineActorType
  ): InvoiceTimelineEntry {
    const resolvedActorType = actorType || this.inferTimelineActorType(message);
    if (resolvedActorType === 'customer') {
      return {
        id,
        createdAt,
        message,
        actorType: 'customer',
        createdBy: 'Customer',
        createdById: ''
      };
    }
    const actor = this.currentActor();
    return {
      id,
      createdAt,
      message,
      actorType: 'system',
      createdBy: actor.name,
      createdById: actor.id
    };
  }

  private safeNumber(value: unknown, fallback: number): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return numeric < 0 ? 0 : numeric;
  }

  private roundCurrency(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(this.roundCurrency(value));
  }

  private cloneInvoice(invoice: InvoiceDetail): InvoiceDetail {
    return {
      ...invoice,
      lineItems: invoice.lineItems.map(line => ({ ...line })),
      timeline: invoice.timeline.map(entry => ({ ...entry })),
      paymentTransactions: (invoice.paymentTransactions || []).map(item => ({ ...item })),
      refundTransactions: (invoice.refundTransactions || []).map(item => ({ ...item }))
    };
  }

  private updateState(mutator: (current: InvoiceDetail[]) => InvoiceDetail[], syncChange = true): void {
    const previous = this.state();
    const next = mutator(previous);
    this.state.set(next);
    this.persistToStorage();
    if (!syncChange || !this.http || !this.auth.isAuthenticated?.()) return;
    const tenant = this.storageTenantId();
    const sync = this.syncFor(tenant);
    const remaining = new Map(previous.map(item => [item.id, item]));
    for (const item of next) {
      const old = remaining.get(item.id);
      remaining.delete(item.id);
      if (item !== old && (!old || JSON.stringify(item) !== JSON.stringify(old))) this.queueDocument(sync, item.id, item);
    }
    for (const id of remaining.keys()) this.queueDocument(sync, id, null);
    this.persistSync(tenant, sync);
    void this.syncDocuments(tenant);
  }

  private queueDocument(sync: DocumentSync, id: string, document: InvoiceDetail | null): void {
    const pending = sync.pending[id];
    sync.pending[id] = { ...pending, document, revision: pending ? pending.revision : sync.revisions[id] ?? null };
  }

  private syncFor(tenant: string): DocumentSync {
    const current = this.syncState.get(tenant);
    if (current) return current;
    let saved: DocumentSync | null = null;
    try { saved = JSON.parse(localStorage.getItem(`${this.storageKey(tenant)}.sync`) || 'null'); } catch {}
    const sync = saved || { revisions: {}, pending: {}, migrated: false };
    this.syncState.set(tenant, sync);
    return sync;
  }

  private persistSync(tenant: string, sync: DocumentSync): void {
    try { localStorage.setItem(`${this.storageKey(tenant)}.sync`, JSON.stringify(sync)); } catch {}
  }

  async waitForSharedDocument(documentId: string): Promise<void> {
    const tenant = this.storageTenantId();
    const sync = this.syncFor(tenant);
    const deadline = Date.now() + 20_000;
    while (this.auth.isAuthenticated?.() && tenant === this.storageTenantId() && Date.now() < deadline) {
      if (sync.pending[documentId]?.conflict) {
        throw new Error('Resolve the document sync conflict before sharing the customer portal.');
      }
      if (sync.revisions[documentId] && !sync.pending[documentId]) return;
      await this.syncDocuments(tenant);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Could not sync the document. Try sharing the portal again.');
  }

  private async syncDocuments(tenant: string): Promise<void> {
    const http = this.http;
    const isActive = () => this.auth.isAuthenticated?.() && tenant === this.storageTenantId();
    if (!http || !isActive() || this.syncing.has(tenant)) return;
    this.syncing.add(tenant);
    const sync = this.syncFor(tenant);
    const headers = { 'x-tenant-id': tenant, 'x-skip-action-toast': '1' };
    try {
      const { items, resetVersion } = await firstValueFrom(http.get<{ items: SharedDocument[]; resetVersion?: string }>('/api/service-documents', { headers }).pipe(timeout(15000)));
      if (!isActive()) return;
      if (resetVersion && sync.resetVersion !== resetVersion) {
        this.state.set([]);
        sync.pending = {};
        sync.revisions = {};
        sync.migrated = true;
        sync.resetVersion = resetVersion;
      }
      const local = new Map(this.state().filter(item => !sync.migrated || !!sync.pending[item.id]).map(item => [item.id, item]));
      for (const row of items) {
        sync.revisions[row.id] = row.revision;
        if (sync.pending[row.id]) continue;
        if (row.document) local.set(row.id, this.normalizeInvoice(row.document));
        else local.delete(row.id);
      }
      if (!sync.migrated) {
        for (const [id, item] of local) {
          if (!sync.revisions[id] && !sync.pending[id]) this.queueDocument(sync, id, item);
        }
        sync.migrated = true;
      }
      this.state.set([...local.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
      this.persistToStorage();
      this.persistSync(tenant, sync);

      for (const [id, pending] of Object.entries(sync.pending)) {
        if (!isActive()) return;
        if (pending.conflict || sync.pending[id] !== pending) continue;
        try {
          const result = await firstValueFrom(http.post<{ revision: string }>('/api/service-documents', {
            id, revision: pending.revision, document: pending.document, resetVersion: sync.resetVersion || ''
          }, { headers }).pipe(timeout(15000)));
          sync.revisions[id] = result.revision;
          if (sync.pending[id] === pending) delete sync.pending[id];
          else if (sync.pending[id]) sync.pending[id].revision = result.revision;
        } catch (error) {
          if (error instanceof HttpErrorResponse && error.status === 409) {
            if (sync.pending[id]) sync.pending[id].conflict = true;
          } else {
            throw error;
          }
        } finally {
          this.persistSync(tenant, sync);
        }
      }
      if (isActive()) this.documentSyncError.set(Object.values(sync.pending).some(row => row.conflict)
        ? 'Another session changed a quote or invoice. Your local edits are still on this device.'
        : '');
    } catch {
      if (isActive()) this.documentSyncError.set('Shared documents are unavailable. Edits on this device are waiting to sync.');
    } finally {
      this.syncing.delete(tenant);
    }
  }

  private storageTenantId(): string {
    return String(this.tenantContext.tenantId() || 'main').trim().toLowerCase() || 'main';
  }

  private storageKey(tenantId: string): string {
    return `${INVOICES_STORAGE_KEY_PREFIX}.${tenantId}`;
  }

  private loadFromStorage(tenantId: string): InvoiceDetail[] {
    const key = this.storageKey(tenantId);
    const fallbackKeys = tenantId === 'main' || tenantId === 'primary-location'
      ? [key, INVOICES_STORAGE_KEY_PREFIX] : [key];
    try {
      let raw = '';
      for (const candidate of fallbackKeys) {
        const value = localStorage.getItem(candidate);
        if (!value) continue;
        raw = value;
        if (candidate !== key) {
          try { localStorage.setItem(key, value); } catch {}
        }
        break;
      }
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const normalized = parsed
        .map(item => this.normalizeInvoice(item as InvoiceDetail))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const legacyMigrated = this.migrateLegacyCompletedInvoices(normalized);
      const siblingMigrated = this.migrateDuplicateActiveQuotes(legacyMigrated);
      const jobMigrated = this.migrateMissingJobNumbers(siblingMigrated);
      return jobMigrated.map(item => this.cloneInvoice(item));
    } catch {
      return [];
    }
  }

  private persistToStorage(): void {
    const key = this.storageKey(this.storageTenantId());
    try {
      localStorage.setItem(key, JSON.stringify(this.state()));
    } catch {
      // Ignore when storage is unavailable.
    }
  }

  private migrateLegacyCompletedInvoices(items: InvoiceDetail[]): InvoiceDetail[] {
    return items || [];
  }

  private hasFinalInvoiceSentTimeline(timeline: InvoiceTimelineEntry[]): boolean {
    return (timeline || []).some(entry => String(entry?.message || '').trim().toLowerCase().includes('final invoice sent to customer'));
  }

  private isCustomerFacingEmailTimelineMessage(message: string | null | undefined, documentType: InvoiceDocumentType): boolean {
    const text = String(message || '').trim().toLowerCase();
    if (!text) return false;

    const hasEmailSignal = text.includes('email') || text.includes('e-mail') || text.includes('emailed');
    const hasSentSignal = text.includes('sent') || text.includes('delivered');
    const hasDocSignal = documentType === 'quote'
      ? text.includes('quote')
      : (text.includes('invoice') || text.includes('final invoice'));

    if (hasEmailSignal && hasSentSignal && hasDocSignal) return true;
    if (hasDocSignal && text.includes('sent to customer')) return true;
    return false;
  }

  private migrateDuplicateActiveQuotes(items: InvoiceDetail[]): InvoiceDetail[] {
    const source = Array.isArray(items) ? items : [];
    if (!source.length) return source;

    const activeQuoteStages = new Set<InvoiceStage>(['draft', 'sent', 'accepted', 'declined']);
    const buckets = new Map<string, number[]>();

    for (let index = 0; index < source.length; index += 1) {
      const item = source[index];
      if (item.documentType !== 'quote') continue;
      if (!activeQuoteStages.has(item.stage)) continue;
      const key = this.quoteDedupKey(item);
      if (!key) continue;
      const list = buckets.get(key) || [];
      list.push(index);
      buckets.set(key, list);
    }

    let changed = false;
    const nowIso = new Date().toISOString();
    const next = [...source];

    for (const indexes of buckets.values()) {
      if (indexes.length <= 1) continue;
      const keepIndex = indexes
        .slice()
        .sort((a, b) => {
          const aItem = source[a];
          const bItem = source[b];
          const stageDiff = this.stageLookupPriority(bItem.stage) - this.stageLookupPriority(aItem.stage);
          if (stageDiff !== 0) return stageDiff;
          const updatedDiff = this.asMillis(bItem.updatedAt || bItem.createdAt) - this.asMillis(aItem.updatedAt || aItem.createdAt);
          if (updatedDiff !== 0) return updatedDiff;
          return this.asMillis(bItem.createdAt) - this.asMillis(aItem.createdAt);
        })[0];
      const keeper = source[keepIndex];

      for (const index of indexes) {
        if (index === keepIndex) continue;
        const candidate = next[index];
        if (candidate.stage === 'canceled' || candidate.stage === 'expired') continue;
        changed = true;
        const timeline = [...candidate.timeline, this.createTimelineEntry(
          `timeline-${candidate.id}-${Date.now()}-dedup`,
          nowIso,
          `Superseded by ${keeper.invoiceNumber}.`
        )];
        next[index] = this.normalizeInvoice({
          ...candidate,
          stage: 'canceled',
          updatedAt: nowIso,
          timeline
        });
      }
    }

    if (changed) {
      setTimeout(() => this.persistToStorage());
    }
    return next;
  }

  private migrateMissingJobNumbers(items: InvoiceDetail[]): InvoiceDetail[] {
    const source = Array.isArray(items) ? items : [];
    if (!source.length) return source;

    const used = new Set<number>();
    for (const item of source) {
      const match = String(item.jobNumber || '').trim().toUpperCase().match(/^JOB-(\d+)$/);
      if (!match) continue;
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0) used.add(value);
    }

    let cursor = 1;
    const nextNumber = () => {
      while (used.has(cursor)) cursor += 1;
      const out = cursor;
      used.add(out);
      cursor += 1;
      return this.formatJobNumber(out);
    };

    let changed = false;
    const migrated = source.map(item => {
      if (this.safeText(item.jobNumber)) return item;
      changed = true;
      return this.normalizeInvoice({
        ...item,
        jobNumber: nextNumber()
      });
    });

    if (changed) {
      setTimeout(() => this.persistToStorage());
    }
    return migrated;
  }

  private quoteDedupKey(item: InvoiceDetail): string {
    const customerId = this.normalize(item.customerId);
    if (customerId) return `id:${customerId}`;
    const email = this.normalize(item.customerEmail);
    if (email) return `email:${email}`;
    const name = this.normalize(item.customerName);
    if (name) return `name:${name}`;
    return '';
  }

  private nextInvoiceSequence(): number {
    const max = this.state().reduce((highest, invoice) => {
      const invoiceNumberMatch = String(invoice.invoiceNumber || '').match(/(\d+)/);
      const idMatch = String(invoice.id || '').match(/(\d+)/);
      const invoiceNumber = invoiceNumberMatch ? Number(invoiceNumberMatch[1]) : NaN;
      const idNumber = idMatch ? Number(idMatch[1]) : NaN;
      const candidate = Math.max(
        Number.isFinite(invoiceNumber) ? invoiceNumber : 0,
        Number.isFinite(idNumber) ? idNumber : 0
      );
      return Math.max(highest, candidate);
    }, 430500);

    return max + 1;
  }

  private nextJobSequence(): number {
    const max = this.state().reduce((highest, invoice) => {
      const match = String(invoice.jobNumber || '').trim().toUpperCase().match(/^JOB-(\d+)$/);
      const value = match ? Number(match[1]) : NaN;
      return Math.max(highest, Number.isFinite(value) ? value : 0);
    }, 0);
    return max + 1;
  }

  private formatJobNumber(value: number): string {
    const next = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
    return `JOB-${String(next).padStart(4, '0')}`;
  }

  private generateDocumentId(): string {
    const random = Math.random().toString(36).slice(2, 8);
    return `inv-${Date.now().toString(36)}-${random}`;
  }

  private formatInvoiceDate(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return this.safeText(value);
    return new Intl.DateTimeFormat('en-US', {
      month: 'numeric',
      day: 'numeric',
      year: 'numeric'
    }).format(date);
  }

  private formatIsoDate(date: Date): string {
    const value = new Date(date.getTime());
    value.setMinutes(value.getMinutes() - value.getTimezoneOffset());
    return value.toISOString().slice(0, 10);
  }

  private stageLabel(stage: InvoiceStage): string {
    return stage.charAt(0).toUpperCase() + stage.slice(1);
  }

  private stageTransitionMessage(fromStage: InvoiceStage, toStage: InvoiceStage): string {
    return `${this.stageLabel(fromStage)} updated to ${this.stageLabel(toStage)}.`;
  }

  private reconcileQuoteSiblings(source: InvoiceDetail[], focus: InvoiceDetail, nowIso: string): InvoiceDetail[] {
    if (focus.documentType !== 'quote') return source;
    const focusStage = this.normalizeStage(focus.stage);
    if (focusStage !== 'sent' && focusStage !== 'accepted') return source;

    const focusId = this.safeText(focus.id);
    const focusCustomerId = this.normalize(focus.customerId);
    const focusEmail = this.normalize(focus.customerEmail);
    const focusName = this.normalize(focus.customerName);
    if (!focusCustomerId && !focusEmail && !focusName) return source;

    return source.map(item => {
      if (item.documentType !== 'quote') return item;
      if (this.safeText(item.id) === focusId) return item;
      if (item.stage === 'canceled' || item.stage === 'expired') return item;

      const sameCustomer =
        (focusCustomerId && focusCustomerId === this.normalize(item.customerId))
        || (focusEmail && focusEmail === this.normalize(item.customerEmail))
        || (focusName && focusName === this.normalize(item.customerName));
      if (!sameCustomer) return item;

      const timeline = [...item.timeline, this.createTimelineEntry(
        `timeline-${item.id}-${Date.now()}-quote-replaced`,
        nowIso,
        `Superseded by ${focus.invoiceNumber}.`
      )];
      return this.normalizeInvoice({
        ...item,
        stage: 'canceled',
        updatedAt: nowIso,
        timeline
      });
    });
  }
}
