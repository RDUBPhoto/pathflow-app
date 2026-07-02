import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonTitle,
  IonToolbar
} from '@ionic/angular/standalone';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { VendorPickerComponent } from '../../components/vendor-picker/vendor-picker.component';
import {
  InventoryApiService,
  InventoryItem,
  InventoryNeed,
  JobPartStatus
} from '../../services/inventory-api.service';
import {
  InvoiceDetail,
  InvoicesDataService
} from '../../services/invoices-data.service';
import { JobPartDraft, JobPartsFoundationService } from '../../services/job-parts-foundation.service';
import { PurchaseOrderLine, PurchaseOrdersApiService } from '../../services/purchase-orders-api.service';

type InventoryEditor = {
  id: string;
  name: string;
  sku: string;
  vendorId: string;
  vendor: string;
  category: string;
  onHand: number;
  reorderAt: number;
  onOrder: number;
  unitCost: number;
  price: number;
};

type InventorySection = 'stock' | 'job-parts' | 'to-order' | 'on-order' | 'received' | 'attention';

type JobPartView = {
  id: string;
  source: 'inventoryneeds' | 'legacy-invoice';
  jobId: string;
  jobNumber: string;
  relatedScheduleId: string;
  relatedInvoiceId: string;
  relatedInvoiceLineItemId: string;
  relatedInventoryItemId: string;
  customerName: string;
  vehicle: string;
  vendorId: string;
  vendor: string;
  unitCost: number;
  installDate: string;
  partName: string;
  sku: string;
  qtyNeeded: number;
  qtyOrdered: number;
  qtyReceived: number;
  qtyPulled: number;
  qtyInstalled: number;
  status: JobPartStatus;
  legacyNeedStatus: string;
  note: string;
  attentionReasons: string[];
};

@Component({
  selector: 'app-inventory',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonContent,
    IonButton,
    IonItem,
    IonLabel,
    IonInput,
    PageBackButtonComponent,
    UserMenuComponent,
    CompanySwitcherComponent,
    VendorPickerComponent
  ],
  templateUrl: './inventory.component.html',
  styleUrls: ['./inventory.component.scss']
})
export default class InventoryComponent implements OnInit {
  readonly pageSize = 30;
  private readonly inventoryApi = inject(InventoryApiService);
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly jobPartsFoundation = inject(JobPartsFoundationService);
  private readonly purchaseOrdersApi = inject(PurchaseOrdersApiService);
  private readonly router = inject(Router);

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly status = signal('');
  readonly error = signal('');
  readonly search = signal('');
  readonly page = signal(1);
  readonly items = signal<InventoryItem[]>([]);
  readonly needs = signal<InventoryNeed[]>([]);
  readonly activeSection = signal<InventorySection>('stock');
  readonly selectedJobPartIds = signal<Set<string>>(new Set());
  readonly selectedItemId = signal('');
  readonly editor = signal<InventoryEditor | null>(null);

  readonly filteredItems = computed(() => {
    const query = this.search().trim().toLowerCase();
    return this.items().filter(item => {
      if (!query) return true;
      const haystack = [
        item.name,
        item.sku,
        item.vendor,
        item.category
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    });
  });
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.filteredItems().length / this.pageSize)));
  readonly pagedItems = computed(() => {
    const maxPage = this.totalPages();
    const page = Math.max(1, Math.min(this.page(), maxPage));
    const start = (page - 1) * this.pageSize;
    return this.filteredItems().slice(start, start + this.pageSize);
  });
  readonly pageStart = computed(() => {
    if (!this.filteredItems().length) return 0;
    const page = Math.max(1, Math.min(this.page(), this.totalPages()));
    return (page - 1) * this.pageSize + 1;
  });
  readonly pageEnd = computed(() => this.pageStart() + this.pagedItems().length - 1);
  readonly selectedItem = computed(() => {
    const id = this.selectedItemId();
    if (!id) return null;
    return this.items().find(item => item.id === id) || null;
  });
  readonly totalOnHand = computed(() => this.items().reduce((sum, item) => sum + this.toNumber(item.onHand, 0), 0));
  readonly totalInventoryValue = computed(() =>
    this.items().reduce(
      (sum, item) => sum + (this.toNumber(item.onHand, 0) * this.toNumber(item.unitCost, 0)),
      0
    )
  );
  readonly inventorySections: Array<{ id: InventorySection; label: string }> = [
    { id: 'stock', label: 'Stock' },
    { id: 'job-parts', label: 'Job Parts' },
    { id: 'to-order', label: 'To Order' },
    { id: 'on-order', label: 'On Order' },
    { id: 'received', label: 'Received / Ready' },
    { id: 'attention', label: 'Attention' }
  ];
  readonly jobPartRows = computed(() => this.buildJobPartRows());
  readonly allJobParts = computed(() => this.jobPartRows());
  readonly toOrderParts = computed(() =>
    this.jobPartRows().filter(row =>
      row.status === 'quoted'
      || row.status === 'backordered'
      || row.legacyNeedStatus === 'needs-order'
      || (row.qtyNeeded > Math.max(row.qtyOrdered, row.qtyReceived))
    )
  );
  readonly onOrderParts = computed(() =>
    this.jobPartRows().filter(row =>
      row.status === 'ordered'
      && row.qtyReceived < row.qtyNeeded
    )
  );
  readonly receivedParts = computed(() =>
    this.jobPartRows().filter(row =>
      row.qtyReceived >= row.qtyNeeded
      || row.status === 'received'
      || row.status === 'pulled'
      || row.status === 'installed'
    )
  );
  readonly attentionParts = computed(() =>
    this.jobPartRows().filter(row => row.attentionReasons.length > 0)
  );
  readonly activeJobParts = computed(() => {
    const section = this.activeSection();
    if (section === 'to-order') return this.toOrderParts();
    if (section === 'on-order') return this.onOrderParts();
    if (section === 'received') return this.receivedParts();
    if (section === 'attention') return this.attentionParts();
    return this.allJobParts();
  });
  readonly legacyFallbackCount = computed(() =>
    this.jobPartRows().filter(row => row.source === 'legacy-invoice').length
  );
  readonly selectedJobParts = computed(() => {
    const ids = this.selectedJobPartIds();
    return this.jobPartRows().filter(row => ids.has(row.id) && this.canCreatePoForPart(row));
  });
  readonly paidInvoices = computed(() =>
    this.invoicesData.invoiceDetails().filter(item => {
      const invoiceNumber = this.normalizeText(item?.invoiceNumber);
      const looksLikeInvoice = item.documentType === 'invoice' || /^inv[-\s]/i.test(invoiceNumber);
      return looksLikeInvoice && this.isPaidInvoice(item) && !this.isCompletedJob(item);
    })
  );
  ngOnInit(): void {
    this.loadInventoryItems();
  }

  loadInventoryItems(): void {
    this.loading.set(true);
    this.error.set('');
    this.inventoryApi.getState().subscribe({
      next: res => {
        const items = this.sortItems(Array.isArray(res?.items) ? res.items : []);
        this.items.set(items);
        this.needs.set(Array.isArray(res?.needs) ? res.needs : []);
        this.syncSelection(items);
        this.page.set(1);
        this.loading.set(false);
      },
      error: err => {
        this.error.set(this.extractError(err, 'Could not load inventory.'));
        this.loading.set(false);
      }
    });
  }

  onHandLabel(item: InventoryItem): string {
    const onHand = Math.max(0, Math.trunc(this.toNumber(item?.onHand, 0)));
    return `${onHand} on hand`;
  }

  onHandClass(item: InventoryItem): string {
    const onHand = Math.max(0, Math.trunc(this.toNumber(item?.onHand, 0)));
    return onHand > 0 ? 'stock-on-hand' : 'stock-zero';
  }

  selectItem(item: InventoryItem): void {
    if (!item?.id) return;
    this.selectedItemId.set(item.id);
    this.editor.set(this.toEditor(item));
    this.status.set('');
    this.error.set('');
  }

  isSelected(item: InventoryItem): boolean {
    return this.selectedItemId() === item.id;
  }

  setEditorText(field: 'name' | 'sku' | 'vendor' | 'category', value: unknown): void {
    const current = this.editor();
    if (!current) return;
    this.editor.set({
      ...current,
      [field]: String(value || '')
    });
  }

  setEditorVendor(selection: { vendorId: string; vendorName: string }): void {
    const current = this.editor();
    if (!current) return;
    this.editor.set({
      ...current,
      vendorId: selection.vendorId || '',
      vendor: selection.vendorName || ''
    });
  }

  setEditorNumber(field: 'onHand' | 'reorderAt' | 'onOrder' | 'unitCost' | 'price', value: unknown): void {
    const current = this.editor();
    if (!current) return;
    this.editor.set({
      ...current,
      [field]: this.toNumber(value, 0)
    });
  }

  hasSelectedChanges(): boolean {
    const item = this.selectedItem();
    const draft = this.editor();
    if (!item || !draft || item.id !== draft.id) return false;
    return (
      this.normalizeText(item.name) !== this.normalizeText(draft.name) ||
      this.normalizeText(item.sku) !== this.normalizeText(draft.sku) ||
      this.normalizeText(item.vendor) !== this.normalizeText(draft.vendor) ||
      this.normalizeText((item as any).vendorId) !== this.normalizeText(draft.vendorId) ||
      this.normalizeText(item.category) !== this.normalizeText(draft.category) ||
      this.toNumber(item.onHand, 0) !== this.toNumber(draft.onHand, 0) ||
      this.toNumber(item.reorderAt, 0) !== this.toNumber(draft.reorderAt, 0) ||
      this.toNumber(item.onOrder, 0) !== this.toNumber(draft.onOrder, 0) ||
      this.toNumber(item.unitCost, 0) !== this.toNumber(draft.unitCost, 0) ||
      this.toNumber(item.price, 0) !== this.toNumber(draft.price, 0)
    );
  }

  saveSelectedItem(): void {
    const draft = this.editor();
    if (!draft) return;
    if (!this.hasSelectedChanges()) {
      this.status.set('No changes to save.');
      return;
    }

    const payload = {
      id: draft.id,
      name: this.normalizeText(draft.name),
      sku: this.normalizeText(draft.sku),
      vendorId: this.normalizeText(draft.vendorId),
      vendor: this.normalizeText(draft.vendor),
      category: this.normalizeText(draft.category),
      onHand: Math.max(0, Math.trunc(this.toNumber(draft.onHand, 0))),
      reorderAt: Math.max(0, Math.trunc(this.toNumber(draft.reorderAt, 0))),
      onOrder: Math.max(0, Math.trunc(this.toNumber(draft.onOrder, 0))),
      unitCost: Math.max(0, this.toNumber(draft.unitCost, 0)),
      price: Math.max(0, this.toNumber(draft.price, 0))
    };

    if (!payload.name && !payload.sku) {
      this.error.set('Part needs at least a name or SKU.');
      return;
    }

    this.saving.set(true);
    this.error.set('');
    this.status.set('');
    this.inventoryApi.upsertItem(payload).subscribe({
      next: res => {
        const saved = res?.item;
        if (!saved?.id) {
          this.error.set('Could not save this part.');
          this.saving.set(false);
          return;
        }
        const nextItems = this.sortItems(
          this.items().map(item => item.id === saved.id ? saved : item)
        );
        this.items.set(nextItems);
        this.selectedItemId.set(saved.id);
        this.editor.set(this.toEditor(saved));
        this.status.set(`Saved ${saved.name || saved.sku || 'part'}.`);
        this.saving.set(false);
      },
      error: err => {
        this.error.set(this.extractError(err, 'Could not save this part.'));
        this.saving.set(false);
      }
    });
  }

  formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2
    }).format(value);
  }

  formatDateTime(value: string): string {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return value;
    return new Date(timestamp).toLocaleString();
  }

  trackInventoryItem(_index: number, item: InventoryItem): string {
    return item.id;
  }

  setSearch(value: string): void {
    this.search.set(value || '');
    this.page.set(1);
  }

  prevPage(): void {
    this.page.update(value => Math.max(1, value - 1));
  }

  nextPage(): void {
    this.page.update(value => Math.min(this.totalPages(), value + 1));
  }

  setActiveSection(section: InventorySection): void {
    this.activeSection.set(section);
  }

  sectionCount(section: InventorySection): number {
    if (section === 'stock') return this.filteredItems().length;
    if (section === 'job-parts') return this.allJobParts().length;
    if (section === 'to-order') return this.toOrderParts().length;
    if (section === 'on-order') return this.onOrderParts().length;
    if (section === 'received') return this.receivedParts().length;
    return this.attentionParts().length;
  }

  activeSectionLabel(): string {
    const section = this.activeSection();
    if (section === 'job-parts') return 'Job Parts';
    if (section === 'to-order') return 'Parts To Order';
    if (section === 'on-order') return 'Parts On Order';
    if (section === 'received') return 'Received / Ready';
    if (section === 'attention') return 'Attention';
    return 'Stock';
  }

  trackJobPart(_index: number, row: JobPartView): string {
    return row.id;
  }

  isJobPartSelected(row: JobPartView): boolean {
    return this.selectedJobPartIds().has(row.id);
  }

  toggleJobPartSelection(row: JobPartView, checked: boolean): void {
    if (!this.canCreatePoForPart(row)) return;
    const next = new Set(this.selectedJobPartIds());
    if (checked) next.add(row.id);
    else next.delete(row.id);
    this.selectedJobPartIds.set(next);
  }

  canCreatePoForPart(row: JobPartView): boolean {
    return row.source === 'inventoryneeds'
      && !!row.id
      && row.qtyNeeded > Math.max(row.qtyOrdered, row.qtyReceived)
      && row.status !== 'received'
      && row.status !== 'pulled'
      && row.status !== 'installed'
      && row.status !== 'returned';
  }

  createPurchaseOrderDraft(): void {
    const selected = this.selectedJobParts();
    if (!selected.length) {
      this.error.set('Select at least one job-linked part that still needs ordering.');
      return;
    }
    const lines: PurchaseOrderLine[] = selected.map((row, index) => {
      const qty = Math.max(1, Math.ceil(row.qtyNeeded - Math.max(row.qtyOrdered, row.qtyReceived)));
      return {
        lineId: `line-${index + 1}`,
        needId: row.id,
        itemId: row.relatedInventoryItemId,
        relatedInventoryItemId: row.relatedInventoryItemId,
        jobId: row.jobId,
        jobNumber: row.jobNumber,
        partName: row.partName,
        sku: row.sku,
        vendor: row.vendor,
        vendorId: row.vendorId,
        qty,
        qtyNeeded: row.qtyNeeded,
        qtyOrdered: row.qtyOrdered,
        qtyReceived: 0,
        unitCost: row.unitCost,
        note: row.note
      };
    });
    const supplier = this.normalizeText(lines.find(line => this.normalizeText(line.vendor))?.vendor) || 'Unassigned Supplier';
    this.saving.set(true);
    this.error.set('');
    this.status.set('');
    this.purchaseOrdersApi.createDraft({ supplier, lines }).subscribe({
      next: res => {
        const id = this.normalizeText(res?.order?.id);
        this.selectedJobPartIds.set(new Set());
        this.saving.set(false);
        this.status.set('Purchase order draft created.');
        this.loadInventoryItems();
        if (id) void this.router.navigate(['/purchase-orders'], { queryParams: { id } });
      },
      error: err => {
        this.error.set(this.extractError(err, 'Could not create purchase order draft.'));
        this.saving.set(false);
      }
    });
  }

  jobPartStatusLabel(status: JobPartStatus | string): string {
    const normalized = this.normalizeText(status).toLowerCase();
    if (normalized === 'quoted') return 'Quoted';
    if (normalized === 'ordered') return 'Ordered';
    if (normalized === 'received') return 'Received';
    if (normalized === 'pulled') return 'Pulled';
    if (normalized === 'installed') return 'Installed';
    if (normalized === 'returned') return 'Returned';
    if (normalized === 'backordered') return 'Backordered';
    return 'Quoted';
  }

  jobPartStatusClass(status: JobPartStatus | string): string {
    const normalized = this.normalizeText(status).toLowerCase();
    if (normalized === 'backordered' || normalized === 'returned') return 'queue-status-backordered';
    if (normalized === 'received' || normalized === 'pulled' || normalized === 'installed') return 'queue-status-received';
    if (normalized === 'ordered') return 'queue-status-in-stock';
    return 'queue-status-needs-order';
  }

  qtyProgressLabel(row: JobPartView): string {
    return `Need ${this.formatQty(row.qtyNeeded)} · Ordered ${this.formatQty(row.qtyOrdered)} · Received ${this.formatQty(row.qtyReceived)} · Pulled ${this.formatQty(row.qtyPulled)} · Installed ${this.formatQty(row.qtyInstalled)}`;
  }

  jobDetailQueryParams(row: JobPartView): Record<string, string> {
    const params: Record<string, string> = {};
    if (row.jobId) params['jobId'] = row.jobId;
    if (row.jobNumber) params['jobNumber'] = row.jobNumber;
    if (row.source === 'inventoryneeds' && row.id) params['needId'] = row.id;
    if (row.relatedScheduleId) params['scheduleId'] = row.relatedScheduleId;
    if (row.relatedInvoiceId) params['invoiceId'] = row.relatedInvoiceId;
    if (row.relatedInvoiceLineItemId) params['invoiceLineItemId'] = row.relatedInvoiceLineItemId;
    return params;
  }

  formatQty(value: number): string {
    const rounded = Math.round(this.toNumber(value, 0) * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
  }

  openJobPartSource(row: JobPartView): void {
    const invoiceId = this.normalizeText(row.relatedInvoiceId);
    if (invoiceId) {
      void this.router.navigate(['/invoices', invoiceId]);
    }
  }

  openInvoiceById(invoiceId: string): void {
    const normalized = this.normalizeText(invoiceId);
    if (!normalized) return;
    void this.router.navigate(['/invoices', normalized]);
  }

  private buildJobPartRows(): JobPartView[] {
    const foundationRows = this.needs().map(need => this.jobPartFromNeed(need));
    const existingKeys = new Set(foundationRows.flatMap(row => this.jobPartMatchKeys(row)));
    const fallbackRows: JobPartView[] = [];

    for (const invoice of this.paidInvoices()) {
      const lines = Array.isArray(invoice.lineItems) ? invoice.lineItems : [];
      for (const line of lines) {
        const draft = this.jobPartsFoundation.mapInvoiceLineToJobPartDraft(invoice, line);
        if (!draft) continue;
        const row = this.jobPartFromDraft(draft, invoice);
        const hasFoundationMatch = this.jobPartMatchKeys(row).some(key => existingKeys.has(key));
        if (hasFoundationMatch) continue;
        fallbackRows.push(row);
        for (const key of this.jobPartMatchKeys(row)) existingKeys.add(key);
      }
    }

    return [...foundationRows, ...fallbackRows].sort((a, b) => {
      const attentionDiff = Number(b.attentionReasons.length > 0) - Number(a.attentionReasons.length > 0);
      if (attentionDiff !== 0) return attentionDiff;
      const dateDiff = this.asMillis(a.installDate) - this.asMillis(b.installDate);
      if (dateDiff !== 0) return dateDiff;
      return this.normalizeText(a.partName).localeCompare(this.normalizeText(b.partName), undefined, { sensitivity: 'base' });
    });
  }

  private jobPartFromNeed(need: InventoryNeed): JobPartView {
    const draft = this.jobPartsFoundation.mapInventoryNeedToJobPart(need);
    return this.jobPartFromDraft(draft, null, need);
  }

  private jobPartFromDraft(draft: JobPartDraft, invoice: InvoiceDetail | null, need?: InventoryNeed): JobPartView {
    const qtyNeeded = this.toNumber(draft.qtyNeeded, this.toNumber((need as any)?.qty, 1));
    const qtyOrdered = this.toNumber(draft.qtyOrdered, 0);
    const qtyReceived = this.toNumber(draft.qtyReceived, 0);
    const qtyPulled = this.toNumber(draft.qtyPulled, 0);
    const qtyInstalled = this.toNumber(draft.qtyInstalled, 0);
    const status = this.normalizeJobPartStatus(draft.status || (need as any)?.jobPartStatus || (need as any)?.status);
    const installDate = this.normalizeText((need as any)?.scheduleStart);
    const row: JobPartView = {
      id: this.normalizeText(draft.id) || `${draft.sourceType}:${draft.sourceId}:${draft.relatedInvoiceLineItemId || draft.partName}`,
      source: need ? 'inventoryneeds' : 'legacy-invoice',
      jobId: this.normalizeText(draft.jobId),
      jobNumber: this.normalizeText(draft.jobNumber),
      relatedScheduleId: this.normalizeText(draft.relatedScheduleId),
      relatedInvoiceId: this.normalizeText(draft.relatedInvoiceId),
      relatedInvoiceLineItemId: this.normalizeText(draft.relatedInvoiceLineItemId),
      relatedInventoryItemId: this.normalizeText(draft.relatedInventoryItemId),
      customerName: this.normalizeText((need as any)?.customerName || invoice?.customerName || 'Customer'),
      vehicle: this.normalizeText((need as any)?.vehicle || invoice?.vehicle),
      vendorId: this.normalizeText((need as any)?.vendorId),
      vendor: this.normalizeText((need as any)?.vendorHint),
      unitCost: this.toNumber(draft.cost || (need as any)?.unitCost || (need as any)?.estimatedCost, 0),
      installDate,
      partName: this.normalizeText(draft.partName || draft.description || 'Part'),
      sku: this.normalizeText(draft.sku),
      qtyNeeded,
      qtyOrdered,
      qtyReceived,
      qtyPulled,
      qtyInstalled,
      status,
      legacyNeedStatus: this.normalizeText(draft.legacyNeedStatus || (need as any)?.status),
      note: this.normalizeText(draft.note || draft.description || (need as any)?.note),
      attentionReasons: []
    };
    row.attentionReasons = this.attentionReasonsForPart(row);
    return row;
  }

  private jobPartMatchKeys(row: JobPartView): string[] {
    const keys: string[] = [];
    if (row.relatedInvoiceLineItemId) keys.push(`line:${row.relatedInvoiceLineItemId}`);
    if (row.relatedInvoiceId && row.sku) keys.push(`invoice-sku:${row.relatedInvoiceId}:${row.sku.toLowerCase()}`);
    if (row.relatedScheduleId && row.sku) keys.push(`schedule-sku:${row.relatedScheduleId}:${row.sku.toLowerCase()}`);
    if (row.jobId && row.sku) keys.push(`job-sku:${row.jobId}:${row.sku.toLowerCase()}`);
    if (row.jobId && row.partName) keys.push(`job-part:${row.jobId}:${row.partName.toLowerCase()}`);
    return keys;
  }

  private attentionReasonsForPart(row: JobPartView): string[] {
    const reasons: string[] = [];
    if (row.status === 'backordered') reasons.push('Backordered');
    if (row.qtyReceived < row.qtyNeeded) reasons.push('Not fully received');
    if (row.qtyReceived > 0 && row.qtyReceived < row.qtyNeeded) reasons.push('Partial received');
    if (this.isInstallApproaching(row.installDate) && row.qtyReceived < row.qtyNeeded) {
      reasons.push('Install approaching');
    }
    return Array.from(new Set(reasons));
  }

  private isInstallApproaching(value: string): boolean {
    const installMs = this.asMillis(value);
    if (!installMs) return false;
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    return installMs >= now && installMs - now <= sevenDays;
  }

  private normalizeJobPartStatus(value: unknown): JobPartStatus {
    const normalized = this.normalizeText(value).toLowerCase();
    if (normalized === 'ordered' || normalized === 'po-draft') return 'ordered';
    if (normalized === 'received' || normalized === 'in-stock') return 'received';
    if (normalized === 'pulled') return 'pulled';
    if (normalized === 'installed') return 'installed';
    if (normalized === 'returned' || normalized === 'cancelled' || normalized === 'canceled') return 'returned';
    if (normalized === 'backordered') return 'backordered';
    return 'quoted';
  }

  private syncSelection(items: InventoryItem[]): void {
    if (!items.length) {
      this.selectedItemId.set('');
      this.editor.set(null);
      return;
    }
    const currentId = this.selectedItemId();
    const selected = items.find(item => item.id === currentId) || items[0];
    if (!selected) {
      this.selectedItemId.set('');
      this.editor.set(null);
      return;
    }
    this.selectedItemId.set(selected.id);
    this.editor.set(this.toEditor(selected));
  }

  private toEditor(item: InventoryItem): InventoryEditor {
    return {
      id: String(item.id || ''),
      name: String(item.name || ''),
      sku: String(item.sku || ''),
      vendorId: String((item as any).vendorId || ''),
      vendor: String(item.vendor || ''),
      category: String(item.category || ''),
      onHand: this.toNumber(item.onHand, 0),
      reorderAt: this.toNumber(item.reorderAt, 0),
      onOrder: this.toNumber(item.onOrder, 0),
      unitCost: this.toNumber(item.unitCost, 0),
      price: this.toNumber(item.price, 0)
    };
  }

  private normalizeText(value: unknown): string {
    return String(value || '').trim();
  }

  private asMillis(value: unknown): number {
    const ts = Date.parse(String(value || '').trim());
    return Number.isFinite(ts) ? ts : 0;
  }

  private isPaidInvoice(item: InvoiceDetail): boolean {
    const total = Math.max(0, this.toNumber(item.total, 0));
    const paid = Math.max(0, this.toNumber(item.paidAmount, 0));
    const hasPaymentTimeline = Array.isArray(item.timeline)
      && item.timeline.some(entry => {
        const message = this.normalizeText(entry?.message).toLowerCase();
        return message.includes('paid')
          || message.includes('payment received')
          || message.includes('customer approved and paid');
      });
    const hasPaymentDate = !!this.normalizeText(item.paymentDate);
    const hasPaymentTransactions = Array.isArray(item.paymentTransactions) && item.paymentTransactions.length > 0;
    const hasPaymentEvidence = hasPaymentDate || hasPaymentTransactions || hasPaymentTimeline;
    const stage = this.normalizeText(item.stage).toLowerCase();
    const isInvoiceLikeStage = stage === 'sent' || stage === 'accepted' || stage === 'completed';

    if (item.stage === 'completed') return true;
    // Some legacy flows leave invoices in "sent" while still recording a payment.
    if (paid > 0 && isInvoiceLikeStage) return true;
    // Paid in full should count regardless of stage, since some legacy flows never
    // advanced stage from "sent" even after collecting payment.
    if (total > 0 && paid >= total) return true;
    if (total <= 0 && paid > 0) return true;
    // Backward compatibility: older paid invoices may have payment evidence
    // without a persisted paidAmount.
    if (hasPaymentEvidence && paid <= 0) return true;
    if (item.stage !== 'accepted') return false;
    if (total <= 0) return paid > 0;
    return paid >= total;
  }

  private isCompletedJob(item: InvoiceDetail): boolean {
    const stage = this.normalizeText(item?.stage).toLowerCase();
    return stage === 'completed';
  }

  private toNumber(value: unknown, fallback = 0): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const cleaned = String(value ?? '')
      .replace(/[$,%\s]/g, '')
      .replace(/,/g, '')
      .trim();
    if (!cleaned) return fallback;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private sortItems(items: InventoryItem[]): InventoryItem[] {
    return [...items].sort((a, b) =>
      this.normalizeText(a.name || a.sku).localeCompare(this.normalizeText(b.name || b.sku), undefined, {
        sensitivity: 'base'
      })
    );
  }

  private extractError(err: any, fallback: string): string {
    return String(err?.error?.error || err?.error?.detail || err?.message || fallback);
  }
}
