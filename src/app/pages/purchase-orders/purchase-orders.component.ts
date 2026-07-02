import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
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
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { VendorPickerComponent } from '../../components/vendor-picker/vendor-picker.component';
import {
  Attachment,
  AttachmentCategory,
  AttachmentsApiService
} from '../../services/attachments-api.service';
import {
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderReceiptLine,
  PurchaseOrdersApiService
} from '../../services/purchase-orders-api.service';

type ReceiptDraft = {
  qtyReceived: number;
  orderNumber: string;
  trackingNumber: string;
  etaDate: string;
  vendorInvoiceNumber: string;
  note: string;
};

type PoAttachmentDraft = {
  category: AttachmentCategory;
  description: string;
};

@Component({
  selector: 'app-purchase-orders',
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
  templateUrl: './purchase-orders.component.html',
  styleUrls: ['./purchase-orders.component.scss']
})
export default class PurchaseOrdersComponent implements OnInit {
  private readonly purchaseOrdersApi = inject(PurchaseOrdersApiService);
  private readonly attachmentsApi = inject(AttachmentsApiService);
  private readonly route = inject(ActivatedRoute);

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly status = signal('');
  readonly error = signal('');
  readonly orders = signal<PurchaseOrder[]>([]);
  readonly selectedOrderId = signal('');
  readonly receiptDrafts = signal<Record<string, ReceiptDraft>>({});
  readonly poAttachments = signal<Attachment[]>([]);
  readonly poAttachmentFile = signal<File | null>(null);
  readonly poAttachmentDraft = signal<PoAttachmentDraft>({ category: 'vendor_invoice', description: '' });

  readonly selectedOrder = computed(() => {
    const id = this.selectedOrderId();
    return this.orders().find(order => order.id === id) || this.orders()[0] || null;
  });

  ngOnInit(): void {
    this.route.queryParamMap.subscribe(params => {
      const id = String(params.get('id') || '').trim();
      if (id) this.selectedOrderId.set(id);
    });
    this.loadOrders();
  }

  loadOrders(): void {
    this.loading.set(true);
    this.error.set('');
    this.purchaseOrdersApi.list().subscribe({
      next: res => {
        const orders = Array.isArray(res?.items) ? res.items : [];
        this.orders.set(orders);
        if (!this.selectedOrderId() && orders[0]) this.selectedOrderId.set(orders[0].id);
        this.seedReceiptDrafts(this.selectedOrder());
        this.loadPoAttachments(this.selectedOrder());
        this.loading.set(false);
      },
      error: err => {
        this.error.set(this.extractError(err, 'Could not load purchase orders.'));
        this.loading.set(false);
      }
    });
  }

  selectOrder(order: PurchaseOrder): void {
    this.selectedOrderId.set(order.id);
    this.seedReceiptDrafts(order);
    this.loadPoAttachments(order);
  }

  submitOrder(order: PurchaseOrder): void {
    this.saving.set(true);
    this.clearMessages();
    this.purchaseOrdersApi.submit(order.id).subscribe({
      next: res => this.replaceOrder(res.order, 'Purchase order submitted.'),
      error: err => this.failSave(err, 'Could not submit purchase order.')
    });
  }

  deleteDraft(order: PurchaseOrder): void {
    this.saving.set(true);
    this.clearMessages();
    this.purchaseOrdersApi.deleteDraft(order.id).subscribe({
      next: () => {
        this.orders.set(this.orders().filter(row => row.id !== order.id));
        this.selectedOrderId.set(this.orders()[0]?.id || '');
        this.status.set('Draft purchase order deleted.');
        this.saving.set(false);
      },
      error: err => this.failSave(err, 'Could not delete purchase order draft.')
    });
  }

  updateOrderVendor(order: PurchaseOrder, selection: { vendorId: string; vendorName: string }): void {
    if (order.status !== 'draft') return;
    if (!selection.vendorId) return;
    this.saving.set(true);
    this.clearMessages();
    this.purchaseOrdersApi.updateDraft(order.id, {
      supplier: selection.vendorName,
      vendorId: selection.vendorId,
      lines: order.lines.map(line => ({
        ...line,
        vendor: line.vendor || selection.vendorName,
        vendorId: line.vendorId || selection.vendorId
      }))
    }).subscribe({
      next: res => this.replaceOrder(res.order, 'Purchase order supplier updated.'),
      error: err => this.failSave(err, 'Could not update purchase order supplier.')
    });
  }

  receiveLine(order: PurchaseOrder, line: PurchaseOrderLine): void {
    const lineId = this.lineId(line);
    const draft = this.receiptDrafts()[lineId];
    const qty = Math.max(0, this.toNumber(draft?.qtyReceived, 0));
    if (qty <= 0) {
      this.error.set('Enter a received quantity greater than zero.');
      return;
    }
    const receipt: PurchaseOrderReceiptLine = {
      lineId,
      qtyReceived: qty,
      orderNumber: draft.orderNumber,
      trackingNumber: draft.trackingNumber,
      etaDate: draft.etaDate,
      vendorInvoiceNumber: draft.vendorInvoiceNumber,
      note: draft.note
    };
    this.receive(order, [receipt], 'Line received.');
  }

  receiveAll(order: PurchaseOrder): void {
    const receipts = order.lines
      .map(line => {
        const lineId = this.lineId(line);
        const remaining = this.remainingQty(line);
        const draft = this.receiptDrafts()[lineId] || this.defaultReceiptDraft(line);
        return {
          lineId,
          qtyReceived: remaining,
          orderNumber: draft.orderNumber,
          trackingNumber: draft.trackingNumber,
          etaDate: draft.etaDate,
          vendorInvoiceNumber: draft.vendorInvoiceNumber,
          note: draft.note
        };
      })
      .filter(line => line.qtyReceived > 0);
    if (!receipts.length) return;
    this.receive(order, receipts, 'Purchase order received.');
  }

  setReceiptField(line: PurchaseOrderLine, field: keyof ReceiptDraft, value: unknown): void {
    const lineId = this.lineId(line);
    const current = this.receiptDrafts()[lineId] || this.defaultReceiptDraft(line);
    this.receiptDrafts.set({
      ...this.receiptDrafts(),
      [lineId]: {
        ...current,
        [field]: field === 'qtyReceived' ? this.toNumber(value, 0) : String(value || '')
      }
    });
  }

  setPoAttachmentField<K extends keyof PoAttachmentDraft>(field: K, value: PoAttachmentDraft[K]): void {
    this.poAttachmentDraft.set({
      ...this.poAttachmentDraft(),
      [field]: value
    });
  }

  setPoAttachmentFile(input: HTMLInputElement): void {
    this.poAttachmentFile.set(input.files && input.files[0] ? input.files[0] : null);
  }

  async uploadPoAttachment(order: PurchaseOrder): Promise<void> {
    const file = this.poAttachmentFile();
    if (!file) {
      this.error.set('Choose a file to upload.');
      return;
    }
    try {
      this.saving.set(true);
      this.clearMessages();
      const firstLine = (order.lines || [])[0] || null;
      const fileDataUrl = await this.attachmentsApi.fileToDataUrl(file);
      this.attachmentsApi.upload({
        jobId: String(firstLine?.jobId || ''),
        jobNumber: String(firstLine?.jobNumber || ''),
        relatedPurchaseOrderId: order.id,
        relatedVendorId: String(order.vendorId || firstLine?.vendorId || ''),
        fileName: file.name,
        originalFileName: file.name,
        contentType: file.type || 'application/octet-stream',
        fileDataUrl,
        category: this.poAttachmentDraft().category,
        description: this.poAttachmentDraft().description
      }).subscribe({
        next: () => {
          this.status.set('Purchase order attachment uploaded.');
          this.poAttachmentFile.set(null);
          this.poAttachmentDraft.set({ category: 'vendor_invoice', description: '' });
          this.saving.set(false);
          this.loadPoAttachments(order);
        },
        error: err => this.failSave(err, 'Could not upload purchase order attachment.')
      });
    } catch (err: any) {
      this.error.set(String(err?.message || 'Could not read attachment.'));
      this.saving.set(false);
    }
  }

  loadPoAttachments(order: PurchaseOrder | null): void {
    if (!order?.id) {
      this.poAttachments.set([]);
      return;
    }
    this.attachmentsApi.list({ purchaseOrderId: order.id }).subscribe({
      next: res => this.poAttachments.set(Array.isArray(res?.attachments) ? res.attachments : []),
      error: () => this.poAttachments.set([])
    });
  }

  remainingQty(line: PurchaseOrderLine): number {
    return Math.max(0, this.toNumber(line.qty, 0) - this.toNumber(line.qtyReceived, 0));
  }

  lineStatusLabel(line: PurchaseOrderLine): string {
    if (this.remainingQty(line) <= 0) return 'Received';
    if (this.toNumber(line.qtyReceived, 0) > 0) return 'Partial';
    return 'Ordered';
  }

  lineStatusClass(line: PurchaseOrderLine): string {
    if (this.remainingQty(line) <= 0) return 'received';
    if (this.toNumber(line.qtyReceived, 0) > 0) return 'partial';
    return 'ordered';
  }

  formatCurrency(value: unknown): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2
    }).format(this.toNumber(value, 0));
  }

  formatDate(value: string | null | undefined): string {
    const ts = Date.parse(String(value || ''));
    if (!Number.isFinite(ts)) return '';
    return new Date(ts).toLocaleString();
  }

  formatBytes(value: unknown): string {
    const bytes = this.toNumber(value, 0);
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${Math.round(bytes)} B`;
  }

  label(value: unknown): string {
    return String(value || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  trackOrder(_index: number, order: PurchaseOrder): string {
    return order.id;
  }

  trackLine(_index: number, line: PurchaseOrderLine): string {
    return this.lineId(line);
  }

  lineId(line: PurchaseOrderLine): string {
    return String(line.lineId || `${line.needId || ''}-${line.partName || ''}-${line.sku || ''}`).trim();
  }

  jobDetailQueryParams(line: PurchaseOrderLine): Record<string, string> {
    const params: Record<string, string> = {};
    if (line.jobId) params['jobId'] = line.jobId;
    if (line.jobNumber) params['jobNumber'] = line.jobNumber;
    if (line.needId) params['needId'] = line.needId;
    return params;
  }

  receiptDraft(line: PurchaseOrderLine): ReceiptDraft {
    return this.receiptDrafts()[this.lineId(line)] || this.defaultReceiptDraft(line);
  }

  private receive(order: PurchaseOrder, receipts: PurchaseOrderReceiptLine[], message: string): void {
    this.saving.set(true);
    this.clearMessages();
    this.purchaseOrdersApi.receive(order.id, receipts).subscribe({
      next: res => this.replaceOrder(res.order, message),
      error: err => this.failSave(err, 'Could not receive purchase order.')
    });
  }

  private replaceOrder(order: PurchaseOrder, message: string): void {
    const next = this.orders().some(row => row.id === order.id)
      ? this.orders().map(row => row.id === order.id ? order : row)
      : [order, ...this.orders()];
    this.orders.set(next);
    this.selectedOrderId.set(order.id);
    this.seedReceiptDrafts(order);
    this.status.set(message);
    this.saving.set(false);
  }

  private seedReceiptDrafts(order: PurchaseOrder | null): void {
    if (!order) {
      this.receiptDrafts.set({});
      return;
    }
    const drafts: Record<string, ReceiptDraft> = {};
    for (const line of order.lines || []) {
      drafts[this.lineId(line)] = this.defaultReceiptDraft(line);
    }
    this.receiptDrafts.set(drafts);
  }

  private defaultReceiptDraft(line: PurchaseOrderLine): ReceiptDraft {
    return {
      qtyReceived: this.remainingQty(line),
      orderNumber: String(line.orderNumber || ''),
      trackingNumber: String(line.trackingNumber || ''),
      etaDate: String(line.etaDate || ''),
      vendorInvoiceNumber: String(line.vendorInvoiceNumber || ''),
      note: String(line.note || '')
    };
  }

  private clearMessages(): void {
    this.status.set('');
    this.error.set('');
  }

  private failSave(err: unknown, fallback: string): void {
    this.error.set(this.extractError(err, fallback));
    this.saving.set(false);
  }

  private toNumber(value: unknown, fallback = 0): number {
    const parsed = Number(String(value ?? '').replace(/[$,%\s]/g, '').replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private extractError(err: any, fallback: string): string {
    return String(err?.error?.error || err?.error?.detail || err?.message || fallback);
  }
}
