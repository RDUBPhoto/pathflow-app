import { UiInput } from '../../ui/controls';
import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
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
  PurchaseOrderTrackingLine,
  PurchaseOrdersApiService
} from '../../services/purchase-orders-api.service';

type ReceiptDraft = {
  qtyReceived: number;
  orderNumber: string;
  trackingNumber: string;
  carrier: string;
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
    UiInput,
    PageBackButtonComponent,
    UserMenuComponent,
    CompanySwitcherComponent,
    VendorPickerComponent
  ],
  templateUrl: './purchase-orders.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
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
  readonly showAttachments = signal(false);

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
    this.showAttachments.set(false);
  }

  toggleAttachments(): void {
    this.showAttachments.set(!this.showAttachments());
  }

  submitOrder(order: PurchaseOrder): void {
    this.saving.set(true);
    this.clearMessages();
    const trackingUpdates = this.trackingUpdatesForOrder(order);
    const submit = () => {
      this.purchaseOrdersApi.submit(order.id).subscribe({
        next: res => this.replaceOrder(res.order, 'Purchase order placed. Mark parts received when they arrive.'),
        error: err => this.failSave(err, 'Could not submit purchase order.')
      });
    };
    if (!trackingUpdates.length) {
      submit();
      return;
    }
    this.purchaseOrdersApi.updateTracking(order.id, trackingUpdates).subscribe({
      next: () => submit(),
      error: err => this.failSave(err, 'Could not save tracking before submitting purchase order.')
    });
  }

  deleteDraft(order: PurchaseOrder): void {
    if (!window.confirm('Delete this draft purchase order? The linked parts will go back to needing a PO.')) return;
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

  cancelOrder(order: PurchaseOrder): void {
    if (!window.confirm('Cancel this purchase order? Linked parts will go back to needing order and on-order stock will be reduced.')) return;
    this.saving.set(true);
    this.clearMessages();
    this.purchaseOrdersApi.cancel(order.id).subscribe({
      next: res => this.replaceOrder(res.order, 'Purchase order cancelled.'),
      error: err => this.failSave(err, 'Could not cancel purchase order.')
    });
  }

  reopenDraft(order: PurchaseOrder): void {
    if (!window.confirm('Reopen this submitted purchase order as a draft? On-order stock will be reversed until it is submitted again.')) return;
    this.saving.set(true);
    this.clearMessages();
    this.purchaseOrdersApi.reopenDraft(order.id).subscribe({
      next: res => this.replaceOrder(res.order, 'Purchase order reopened as draft.'),
      error: err => this.failSave(err, 'Could not reopen purchase order.')
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
      carrier: draft.carrier,
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
          carrier: draft.carrier,
          etaDate: draft.etaDate,
          vendorInvoiceNumber: draft.vendorInvoiceNumber,
          note: draft.note
        };
      })
      .filter(line => line.qtyReceived > 0);
    if (!receipts.length) return;
    this.receive(order, receipts, 'Purchase order received.');
  }

  saveLineTracking(order: PurchaseOrder, line: PurchaseOrderLine): void {
    const lineId = this.lineId(line);
    const draft = this.receiptDrafts()[lineId] || this.defaultReceiptDraft(line);
    const update: PurchaseOrderTrackingLine = {
      lineId,
      orderNumber: draft.orderNumber,
      trackingNumber: draft.trackingNumber,
      carrier: draft.carrier,
      etaDate: draft.etaDate,
      vendorInvoiceNumber: draft.vendorInvoiceNumber,
      note: draft.note
    };
    this.saving.set(true);
    this.clearMessages();
    this.purchaseOrdersApi.updateTracking(order.id, [update]).subscribe({
      next: res => this.replaceOrder(res.order, 'Purchase order tracking updated.'),
      error: err => this.failSave(err, 'Could not update purchase order tracking.')
    });
  }

  refreshLineTracking(order: PurchaseOrder, line: PurchaseOrderLine): void {
    const lineId = this.lineId(line);
    const draft = this.receiptDrafts()[lineId] || this.defaultReceiptDraft(line);
    const trackingNumber = String(draft.trackingNumber || line.trackingNumber || '').trim();
    if (!trackingNumber) {
      this.error.set('Enter a tracking number before refreshing package status.');
      return;
    }

    this.saving.set(true);
    this.clearMessages();
    this.purchaseOrdersApi.refreshTracking(order.id, [{
      lineId,
      trackingNumber,
      carrier: draft.carrier
    }]).subscribe({
      next: res => {
        const first = Array.isArray(res.tracking) ? res.tracking[0] : null;
        const message = first?.ok
          ? `Tracking refreshed${first.trackingStatus ? `: ${first.trackingStatus}` : ''}.`
          : String(first?.error || 'Tracking refresh could not reach EasyPost.');
        this.replaceOrder(res.order, message);
        if (first && !first.ok) this.error.set(String(first.error || 'Tracking refresh failed.'));
      },
      error: err => this.failSave(err, 'Could not refresh package tracking.')
    });
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

  lineStatusLabel(line: PurchaseOrderLine, order?: PurchaseOrder | null): string {
    if (order?.status === 'cancelled' || line.status === 'cancelled') return 'Cancelled';
    if (this.remainingQty(line) <= 0) return 'Received';
    if (this.toNumber(line.qtyReceived, 0) > 0) return 'Partial';
    if (order?.status === 'draft') return this.hasVendorOrderDetails(line) ? 'Ready to order' : 'Draft';
    return 'Order placed';
  }

  orderStatusLabel(order: PurchaseOrder | null | undefined): string {
    const status = String(order?.status || '').toLowerCase();
    if (status === 'ordered') return 'Order placed';
    if (status === 'received') return 'Received';
    if (status === 'cancelled') return 'Cancelled';
    return 'Draft';
  }

  lineStatusClass(line: PurchaseOrderLine, order?: PurchaseOrder | null): string {
    if (order?.status === 'cancelled' || line.status === 'cancelled') return 'cancelled';
    if (this.remainingQty(line) <= 0) return 'received';
    if (this.toNumber(line.qtyReceived, 0) > 0) return 'partial';
    if (order?.status === 'draft') return this.hasVendorOrderDetails(line) ? 'ready' : 'draft';
    return 'ordered';
  }

  hasVendorOrderDetails(line: PurchaseOrderLine): boolean {
    return !!String(line.orderNumber || line.trackingNumber || line.etaDate || line.vendorInvoiceNumber || '').trim();
  }

  trackingUpdatesForOrder(order: PurchaseOrder): PurchaseOrderTrackingLine[] {
    return (order.lines || [])
      .map(line => {
        const lineId = this.lineId(line);
        const draft = this.receiptDrafts()[lineId] || this.defaultReceiptDraft(line);
        return {
          lineId,
          orderNumber: draft.orderNumber,
          trackingNumber: draft.trackingNumber,
          carrier: draft.carrier,
          etaDate: draft.etaDate,
          vendorInvoiceNumber: draft.vendorInvoiceNumber,
          note: draft.note
        };
      })
      .filter(line => !!String([
        line.orderNumber,
        line.trackingNumber,
        line.carrier,
        line.etaDate,
        line.vendorInvoiceNumber,
        line.note
      ].join('')).trim());
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

  formatDateOnly(value: string | null | undefined): string {
    const ts = Date.parse(String(value || ''));
    if (!Number.isFinite(ts)) return '';
    return new Date(ts).toLocaleDateString();
  }

  trackingUrl(value: unknown): string {
    const tracking = String(value || '').trim();
    if (!tracking) return '';
    return `https://www.google.com/search?q=${encodeURIComponent(`${tracking} tracking`)}`;
  }

  trackingSummary(line: PurchaseOrderLine): string {
    const parts = [
      line.carrier,
      line.trackingStatus,
      line.estimatedDeliveryDate ? `ETA ${this.formatDateOnly(line.estimatedDeliveryDate)}` : '',
      line.trackingStatusUpdatedAt ? `Updated ${this.formatDate(line.trackingStatusUpdatedAt)}` : ''
    ].map(value => String(value || '').trim()).filter(Boolean);
    return parts.join(' · ');
  }

  formatQty(value: unknown): string {
    const numeric = this.toNumber(value, 0);
    return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
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
    return String(line.lineId || line.needId || line.sku || line.partName || _index);
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

  printReceivingSummary(order: PurchaseOrder): void {
    this.openPrintWindow(
      `PO Receiving Summary - ${this.escapeText(order.id)}`,
      this.printDocument('PO Receiving Summary', this.receivingSummaryHtml(order))
    );
  }

  receiptDraft(line: PurchaseOrderLine): ReceiptDraft {
    return this.receiptDrafts()[this.lineId(line)] || this.defaultReceiptDraft(line);
  }

  private receivingSummaryHtml(order: PurchaseOrder): string {
    const attachments = this.poAttachments();
    const jobNumbers = Array.from(new Set(
      (order.lines || [])
        .map(line => String(line.jobNumber || line.jobId || '').trim())
        .filter(Boolean)
    ));
    const totalOrdered = (order.lines || []).reduce((sum, line) => sum + this.toNumber(line.qty, 0), 0);
    const totalReceived = (order.lines || []).reduce((sum, line) => sum + this.toNumber(line.qtyReceived, 0), 0);
    return `
      <header class="print-header">
        <div>
          <p>Pathflow</p>
          <h1>PO Receiving Summary</h1>
        </div>
        <dl>
          <div><dt>PO</dt><dd>${this.escapeText(order.id)}</dd></div>
          <div><dt>Supplier</dt><dd>${this.escapeText(order.supplier || 'No supplier')}</dd></div>
          <div><dt>Status</dt><dd>${this.escapeText(this.label(order.status))}</dd></div>
          <div><dt>Jobs</dt><dd>${this.escapeText(jobNumbers.join(', ') || 'None linked')}</dd></div>
        </dl>
      </header>

      ${totalReceived < totalOrdered ? `<section class="print-warning">Partial or missing quantities remain on this purchase order.</section>` : ''}

      <section class="print-grid">
        <article>
          <h2>Receiving Progress</h2>
          <dl class="print-dl">
            <div><dt>Ordered</dt><dd>${this.formatQty(totalOrdered)}</dd></div>
            <div><dt>Received</dt><dd>${this.formatQty(totalReceived)}</dd></div>
            <div><dt>Remaining</dt><dd>${this.formatQty(Math.max(0, totalOrdered - totalReceived))}</dd></div>
          </dl>
        </article>
        <article>
          <h2>Dates</h2>
          <dl class="print-dl">
            <div><dt>Created</dt><dd>${this.escapeText(this.formatDate(order.createdAt) || 'N/A')}</dd></div>
            <div><dt>Submitted</dt><dd>${this.escapeText(this.formatDate(order.submittedAt) || 'N/A')}</dd></div>
            <div><dt>Received</dt><dd>${this.escapeText(this.formatDate(order.receivedAt) || 'N/A')}</dd></div>
          </dl>
        </article>
      </section>

      <section class="print-section">
        <h2>Lines</h2>
        ${this.poLinesTableHtml(order)}
      </section>

      <section class="print-section">
        <h2>Attachments</h2>
        ${attachments.length ? `
          <ul class="print-list">
            ${attachments.map(attachment => `
              <li>
                <strong>${this.escapeText(attachment.originalFileName || attachment.fileName)}</strong>
                ${this.escapeText(this.label(attachment.category))}${attachment.description ? ` · ${this.escapeText(attachment.description)}` : ''}
              </li>
            `).join('')}
          </ul>
        ` : '<div class="empty-print">No PO attachments linked.</div>'}
      </section>
    `;
  }

  private poLinesTableHtml(order: PurchaseOrder): string {
    if (!order.lines.length) return '<div class="empty-print">No purchase order lines found.</div>';
    return `
      <table class="print-table">
        <thead>
          <tr>
            <th>Part</th>
            <th>Job</th>
            <th>Vendor</th>
            <th>SKU</th>
            <th>Ordered</th>
            <th>Received</th>
            <th>Remaining</th>
            <th>Order #</th>
            <th>Tracking</th>
            <th>ETA</th>
            <th>Vendor Invoice</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${order.lines.map(line => `
            <tr>
              <td><strong>${this.escapeText(line.partName || 'Part')}</strong><small>${this.escapeText(line.note || '')}</small></td>
              <td>${this.escapeText(line.jobNumber || line.jobId || 'Job TBD')}</td>
              <td>${this.escapeText(line.vendor || order.supplier || 'No supplier')}</td>
              <td>${this.escapeText(line.sku || 'N/A')}</td>
              <td>${this.formatQty(line.qty)}</td>
              <td>${this.formatQty(line.qtyReceived)}</td>
              <td>${this.formatQty(this.remainingQty(line))}</td>
              <td>${this.escapeText(line.orderNumber || 'N/A')}</td>
              <td>${this.escapeText(line.trackingNumber || 'N/A')}</td>
              <td>${this.escapeText(this.formatDate(line.etaDate) || 'N/A')}</td>
              <td>${this.escapeText(line.vendorInvoiceNumber || 'N/A')}</td>
              <td>${this.escapeText(this.lineStatusLabel(line, order))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  private printDocument(title: string, body: string): string {
    return `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${this.escapeText(title)}</title>
          <style>${this.printCss()}</style>
        </head>
        <body>${body}</body>
      </html>
    `;
  }

  private printCss(): string {
    return `
      @page { size: letter; margin: 0.5in; }
      * { box-sizing: border-box; }
      body { margin: 0; color: #111827; font: 12px/1.4 Arial, Helvetica, sans-serif; background: #fff; }
      h1, h2, h3, p { margin: 0; }
      h1 { font-size: 24px; }
      h2 { margin-bottom: 10px; font-size: 15px; }
      small { display: block; color: #4b5563; }
      .print-header { display: flex; justify-content: space-between; gap: 24px; padding-bottom: 16px; border-bottom: 2px solid #111827; margin-bottom: 18px; }
      .print-header p { color: #2563eb; font-weight: 800; text-transform: uppercase; letter-spacing: 0.12em; }
      .print-header dl, .print-dl { display: grid; gap: 6px; margin: 0; }
      .print-header dl { min-width: 280px; }
      dl div { display: grid; grid-template-columns: 100px 1fr; gap: 8px; }
      dt { color: #6b7280; font-weight: 700; text-transform: uppercase; font-size: 10px; }
      dd { margin: 0; font-weight: 700; }
      .print-section { break-inside: avoid; margin: 18px 0; }
      .print-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin: 18px 0; }
      .print-warning { margin: 14px 0; padding: 10px 12px; border: 1px solid #f59e0b; background: #fffbeb; color: #92400e; font-weight: 800; }
      .print-table { width: 100%; border-collapse: collapse; }
      .print-table th, .print-table td { padding: 7px 8px; border: 1px solid #d1d5db; text-align: left; vertical-align: top; }
      .print-table th { background: #f3f4f6; color: #374151; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
      .print-list { margin: 0; padding-left: 18px; }
      .print-list li { margin-bottom: 6px; }
      .empty-print { padding: 10px; border: 1px dashed #d1d5db; color: #6b7280; }
      @media print {
        button, .ui-header, app-user-menu, app-company-switcher, app-page-back-button { display: none !important; }
      }
    `;
  }

  private openPrintWindow(title: string, html: string): void {
    const printWindow = window.open('', '_blank', 'width=960,height=720');
    if (!printWindow) {
      this.error.set('Pop-up blocked. Allow pop-ups to print this document.');
      return;
    }
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.focus();
    setTimeout(() => printWindow.print(), 250);
  }

  private escapeText(value: unknown): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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
      carrier: String(line.carrier || ''),
      etaDate: String(line.etaDate || line.estimatedDeliveryDate || ''),
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
