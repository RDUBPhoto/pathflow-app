import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
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
import {
  InventoryApiService,
  InventoryItem
} from '../../services/inventory-api.service';
import { PurchaseOrdersApiService } from '../../services/purchase-orders-api.service';
import {
  InvoiceDetail,
  InvoicePartStatus,
  InvoicesDataService
} from '../../services/invoices-data.service';

type InventoryEditor = {
  id: string;
  name: string;
  sku: string;
  vendor: string;
  category: string;
  onHand: number;
  reorderAt: number;
  onOrder: number;
  unitCost: number;
};

type PartsQueueRow = {
  key: string;
  label: string;
  sku: string;
  qty: number;
  customerCount: number;
  invoiceCount: number;
  status: InvoicePartStatus;
  latestUpdatedAt: string;
  sampleInvoiceId: string;
  sampleInvoiceNumber: string;
};

type PartsQueueInvoiceLine = {
  id: string;
  label: string;
  sku: string;
  qty: number;
  status: InvoicePartStatus;
};

type PartsQueueInvoiceGroup = {
  invoiceId: string;
  invoiceNumber: string;
  customerName: string;
  updatedAt: string;
  lines: PartsQueueInvoiceLine[];
};

@Component({
  selector: 'app-inventory',
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
    IonItem,
    IonLabel,
    IonInput,
    PageBackButtonComponent,
    UserMenuComponent,
    CompanySwitcherComponent
  ],
  templateUrl: './inventory.component.html',
  styleUrls: ['./inventory.component.scss']
})
export default class InventoryComponent implements OnInit {
  readonly pageSize = 30;
  private readonly inventoryApi = inject(InventoryApiService);
  private readonly purchaseOrdersApi = inject(PurchaseOrdersApiService);
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly router = inject(Router);

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly status = signal('');
  readonly error = signal('');
  readonly search = signal('');
  readonly page = signal(1);
  readonly items = signal<InventoryItem[]>([]);
  readonly selectedItemId = signal('');
  readonly editor = signal<InventoryEditor | null>(null);
  readonly queueWorkspaceOpen = signal(false);
  readonly selectedQueueInvoiceId = signal('');
  readonly queueSavingKey = signal('');

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
  readonly paidInvoices = computed(() =>
    this.invoicesData.invoiceDetails().filter(item => {
      const invoiceNumber = this.normalizeText(item?.invoiceNumber);
      const looksLikeInvoice = item.documentType === 'invoice' || /^inv[-\s]/i.test(invoiceNumber);
      return looksLikeInvoice && this.isPaidInvoice(item);
    })
  );
  readonly partsQueueRows = computed(() => {
    const grouped = new Map<string, {
      label: string;
      sku: string;
      qty: number;
      customerIds: Set<string>;
      invoiceIds: Set<string>;
      latestUpdatedMs: number;
      latestUpdatedAt: string;
      latestInvoiceId: string;
      latestInvoiceNumber: string;
      hasBackordered: boolean;
      hasOrdered: boolean;
    }>();

    for (const invoice of this.paidInvoices()) {
      const updatedAt = String(invoice.updatedAt || invoice.createdAt || '').trim();
      const updatedMs = this.asMillis(updatedAt);
      const customerId = this.normalizeText(invoice.customerId || '').toLowerCase()
        || this.normalizeText(invoice.customerEmail || '').toLowerCase()
        || this.normalizeText(invoice.customerName || '').toLowerCase();

      for (const line of Array.isArray(invoice.lineItems) ? invoice.lineItems : []) {
        // Backward compatibility: some legacy docs did not persist a clean line type.
        // Treat anything not explicitly labor as a part candidate for ordering.
        const normalizedLineType = this.normalizeText((line as any)?.type).toLowerCase();
        if (normalizedLineType === 'labor') continue;
        const normalizedStatus = this.normalizePartStatus(line.partStatus);
        if (normalizedStatus === 'received' || normalizedStatus === 'in-stock') continue;

        const qty = Math.max(0, this.toNumber(line.quantity, 0));
        if (qty <= 0) continue;
        const sku = this.normalizeText(line.code);
        const label = this.normalizeText(line.description || sku || 'Part');
        const key = `${sku.toLowerCase()}::${label.toLowerCase()}`;

        const existing = grouped.get(key);
        if (!existing) {
          grouped.set(key, {
            label,
            sku,
            qty,
            customerIds: new Set(customerId ? [customerId] : []),
            invoiceIds: new Set([invoice.id]),
            latestUpdatedMs: updatedMs,
            latestUpdatedAt: updatedAt,
            latestInvoiceId: String(invoice.id || '').trim(),
            latestInvoiceNumber: String(invoice.invoiceNumber || '').trim(),
            hasBackordered: normalizedStatus === 'backordered',
            hasOrdered: normalizedStatus === 'ordered'
          });
          continue;
        }

        existing.qty += qty;
        if (customerId) existing.customerIds.add(customerId);
        existing.invoiceIds.add(invoice.id);
        existing.hasBackordered = existing.hasBackordered || normalizedStatus === 'backordered';
        existing.hasOrdered = existing.hasOrdered || normalizedStatus === 'ordered';
        if (updatedMs >= existing.latestUpdatedMs) {
          existing.latestUpdatedMs = updatedMs;
          existing.latestUpdatedAt = updatedAt;
          existing.latestInvoiceId = String(invoice.id || '').trim();
          existing.latestInvoiceNumber = String(invoice.invoiceNumber || '').trim();
        }
      }
    }

    return Array.from(grouped.entries())
      .map(([key, value]): PartsQueueRow => ({
        key,
        label: value.label,
        sku: value.sku,
        qty: Math.round(value.qty * 100) / 100,
        customerCount: value.customerIds.size,
        invoiceCount: value.invoiceIds.size,
        status: value.hasBackordered ? 'backordered' : (value.hasOrdered ? 'ordered' : 'ordered'),
        latestUpdatedAt: value.latestUpdatedAt,
        sampleInvoiceId: value.latestInvoiceId,
        sampleInvoiceNumber: value.latestInvoiceNumber
      }))
      .sort((a, b) => {
        const statusDiff = this.partsQueueStatusPriority(a.status) - this.partsQueueStatusPriority(b.status);
        if (statusDiff !== 0) return statusDiff;
        const qtyDiff = b.qty - a.qty;
        if (qtyDiff !== 0) return qtyDiff;
        return this.normalizeText(a.label).localeCompare(this.normalizeText(b.label), undefined, { sensitivity: 'base' });
      });
  });
  readonly queueTotalQty = computed(() =>
    this.partsQueueRows().reduce((sum, row) => sum + this.toNumber(row.qty, 0), 0)
  );
  readonly queueBackorderedCount = computed(() =>
    this.partsQueueRows().filter(row => row.status === 'backordered').length
  );
  readonly queuePreviewRows = computed(() => this.partsQueueRows().slice(0, 3));
  readonly queueInvoiceGroups = computed(() => {
    const groups: PartsQueueInvoiceGroup[] = [];
    for (const invoice of this.paidInvoices()) {
      const invoiceId = this.normalizeText(invoice.id);
      if (!invoiceId) continue;
      const lines: PartsQueueInvoiceLine[] = [];
      for (const line of Array.isArray(invoice.lineItems) ? invoice.lineItems : []) {
        const normalizedLineType = this.normalizeText((line as any)?.type).toLowerCase();
        if (normalizedLineType === 'labor') continue;
        const status = this.normalizePartStatus(line.partStatus);
        if (status === 'received' || status === 'in-stock') continue;
        const qty = Math.max(0, this.toNumber(line.quantity, 0));
        if (qty <= 0) continue;
        lines.push({
          id: this.normalizeText(line.id),
          label: this.normalizeText(line.description || line.code || 'Part'),
          sku: this.normalizeText(line.code),
          qty: Math.round(qty * 100) / 100,
          status
        });
      }
      if (!lines.length) continue;
      groups.push({
        invoiceId,
        invoiceNumber: this.normalizeText(invoice.invoiceNumber),
        customerName: this.normalizeText(invoice.customerName || 'Customer'),
        updatedAt: this.normalizeText(invoice.updatedAt || invoice.createdAt || ''),
        lines
      });
    }
    return groups.sort((a, b) => this.asMillis(b.updatedAt) - this.asMillis(a.updatedAt));
  });
  readonly selectedQueueInvoice = computed(() => {
    const selectedId = this.normalizeText(this.selectedQueueInvoiceId());
    const groups = this.queueInvoiceGroups();
    if (!groups.length) return null;
    if (selectedId) {
      const match = groups.find(group => group.invoiceId === selectedId);
      if (match) return match;
    }
    return groups[0];
  });

  ngOnInit(): void {
    this.loadInventoryItems();
  }

  loadInventoryItems(): void {
    this.loading.set(true);
    this.error.set('');
    this.inventoryApi.listItems().subscribe({
      next: res => {
        const items = this.sortItems(Array.isArray(res?.items) ? res.items : []);
        this.items.set(items);
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

  setEditorNumber(field: 'onHand' | 'reorderAt' | 'onOrder' | 'unitCost', value: unknown): void {
    const current = this.editor();
    if (!current) return;
    this.editor.set({
      ...current,
      [field]: this.toNumber(value, 0)
    });
  }

  resetSelectedEditor(): void {
    const item = this.selectedItem();
    if (!item) return;
    this.editor.set(this.toEditor(item));
    this.status.set('Changes reset.');
    this.error.set('');
  }

  hasSelectedChanges(): boolean {
    const item = this.selectedItem();
    const draft = this.editor();
    if (!item || !draft || item.id !== draft.id) return false;
    return (
      this.normalizeText(item.name) !== this.normalizeText(draft.name) ||
      this.normalizeText(item.sku) !== this.normalizeText(draft.sku) ||
      this.normalizeText(item.vendor) !== this.normalizeText(draft.vendor) ||
      this.normalizeText(item.category) !== this.normalizeText(draft.category) ||
      this.toNumber(item.onHand, 0) !== this.toNumber(draft.onHand, 0) ||
      this.toNumber(item.reorderAt, 0) !== this.toNumber(draft.reorderAt, 0) ||
      this.toNumber(item.onOrder, 0) !== this.toNumber(draft.onOrder, 0) ||
      this.toNumber(item.unitCost, 0) !== this.toNumber(draft.unitCost, 0)
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
      vendor: this.normalizeText(draft.vendor),
      category: this.normalizeText(draft.category),
      onHand: Math.max(0, Math.trunc(this.toNumber(draft.onHand, 0))),
      reorderAt: Math.max(0, Math.trunc(this.toNumber(draft.reorderAt, 0))),
      onOrder: Math.max(0, Math.trunc(this.toNumber(draft.onOrder, 0))),
      unitCost: Math.max(0, this.toNumber(draft.unitCost, 0))
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

  createReorderDraft(item: InventoryItem): void {
    const qty = 1;
    this.saving.set(true);
    this.error.set('');
    this.purchaseOrdersApi.createDraft({
      supplier: item.vendor || 'Unassigned Supplier',
      note: `PO draft created from catalog item ${item.name}`,
      lines: [
        {
          itemId: item.id,
          partName: item.name,
          sku: item.sku,
          vendor: item.vendor,
          qty,
          unitCost: item.unitCost
        }
      ]
    }).subscribe({
      next: res => {
        this.status.set(`PO draft ${res.order.id.slice(0, 8)} created for ${item.name}.`);
        this.saving.set(false);
        this.loadInventoryItems();
      },
      error: err => {
        this.error.set(this.extractError(err, 'Could not create PO draft.'));
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

  trackPartsQueueRow(_index: number, row: PartsQueueRow): string {
    return row.key;
  }

  trackQueueInvoiceGroup(_index: number, group: PartsQueueInvoiceGroup): string {
    return group.invoiceId;
  }

  partsQueueStatusLabel(status: InvoicePartStatus): string {
    if (status === 'backordered') return 'Backordered';
    if (status === 'ordered') return 'Needs order';
    if (status === 'in-stock') return 'In-stock';
    return 'Received';
  }

  partsQueueStatusClass(status: InvoicePartStatus): string {
    if (status === 'backordered') return 'queue-status-backordered';
    if (status === 'ordered') return 'queue-status-needs-order';
    if (status === 'in-stock') return 'queue-status-in-stock';
    return 'queue-status-received';
  }

  openInvoiceFromQueue(row: PartsQueueRow): void {
    const invoiceId = this.normalizeText(row?.sampleInvoiceId);
    if (!invoiceId) return;
    void this.router.navigate(['/invoices', invoiceId]);
  }

  openInvoiceById(invoiceId: string): void {
    const normalized = this.normalizeText(invoiceId);
    if (!normalized) return;
    void this.router.navigate(['/invoices', normalized]);
  }

  openQueueWorkspace(): void {
    this.queueWorkspaceOpen.set(true);
    const selected = this.selectedQueueInvoice();
    this.selectedQueueInvoiceId.set(selected?.invoiceId || '');
  }

  closeQueueWorkspace(): void {
    this.queueWorkspaceOpen.set(false);
  }

  selectQueueInvoice(invoiceId: string): void {
    this.selectedQueueInvoiceId.set(this.normalizeText(invoiceId));
  }

  updateQueueLineStatus(invoiceId: string, lineId: string, nextStatus: string): void {
    const normalizedInvoiceId = this.normalizeText(invoiceId);
    const normalizedLineId = this.normalizeText(lineId);
    if (!normalizedInvoiceId || !normalizedLineId) return;
    const status = this.normalizePartStatus(nextStatus);
    const savingKey = `${normalizedInvoiceId}::${normalizedLineId}`;
    this.queueSavingKey.set(savingKey);
    this.error.set('');
    this.status.set('');

    const detail = this.invoicesData.getInvoiceById(normalizedInvoiceId);
    if (!detail) {
      this.queueSavingKey.set('');
      this.error.set('Could not find invoice for this part line.');
      return;
    }

    const updated = {
      ...detail,
      lineItems: (detail.lineItems || []).map(line => {
        if (this.normalizeText(line.id) !== normalizedLineId) return line;
        const normalizedLineType = this.normalizeText((line as any)?.type).toLowerCase();
        if (normalizedLineType === 'labor') return line;
        return { ...line, partStatus: status };
      })
    };

    try {
      this.invoicesData.saveInvoice(updated);
      this.status.set(`Updated part status to ${this.partsQueueStatusLabel(status)}.`);
    } catch (err: any) {
      this.error.set(this.extractError(err, 'Could not update part status.'));
    } finally {
      this.queueSavingKey.set('');
      const currentSelected = this.selectedQueueInvoice();
      if (currentSelected) this.selectedQueueInvoiceId.set(currentSelected.invoiceId);
    }
  }

  isQueueLineSaving(invoiceId: string, lineId: string): boolean {
    return this.queueSavingKey() === `${this.normalizeText(invoiceId)}::${this.normalizeText(lineId)}`;
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
      vendor: String(item.vendor || ''),
      category: String(item.category || ''),
      onHand: this.toNumber(item.onHand, 0),
      reorderAt: this.toNumber(item.reorderAt, 0),
      onOrder: this.toNumber(item.onOrder, 0),
      unitCost: this.toNumber(item.unitCost, 0)
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

  private normalizePartStatus(value: unknown): InvoicePartStatus {
    const normalized = this.normalizeText(value).toLowerCase();
    if (normalized === 'backordered' || normalized === 'back-order' || normalized === 'back order') return 'backordered';
    if (normalized === 'received') return 'received';
    if (normalized === 'in-stock' || normalized === 'in stock' || normalized === 'instock') return 'in-stock';
    return 'ordered';
  }

  private partsQueueStatusPriority(status: InvoicePartStatus): number {
    if (status === 'backordered') return 0;
    if (status === 'ordered') return 1;
    if (status === 'in-stock') return 2;
    return 3;
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
