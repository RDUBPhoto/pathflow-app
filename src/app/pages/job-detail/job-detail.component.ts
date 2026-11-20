import { UiInput } from '../../ui/controls';
import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../../auth/auth.service';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { VendorPickerComponent } from '../../components/vendor-picker/vendor-picker.component';
import {
  AdditionalPart,
  AdditionalPartApprovalStatus,
  AdditionalPartBillingStatus,
  AdditionalPartInvoiceReviewStatus,
  AdditionalPartPayload,
  AdditionalPartStatus,
  AdditionalPartsApiService
} from '../../services/additional-parts-api.service';
import {
  Attachment,
  AttachmentCategory,
  AttachmentUploadPayload,
  AttachmentsApiService
} from '../../services/attachments-api.service';
import { JobDetailPart, JobDetailPayload, JobDetailQuery, JobDetailService } from '../../services/job-detail.service';
import { JobTask, JobTaskPayload, JobTasksApiService } from '../../services/job-tasks-api.service';
import { NotificationsApiService } from '../../services/notifications-api.service';
import { PurchaseOrderLine, PurchaseOrdersApiService } from '../../services/purchase-orders-api.service';

type AdditionalPartDraft = {
  partName: string;
  sku: string;
  vendorId: string;
  vendor: string;
  description: string;
  quantity: number;
  cost: number;
  markup: number;
  customerPrice: number;
  reasonNotes: string;
  approvalStatus: AdditionalPartApprovalStatus;
  billingStatus: AdditionalPartBillingStatus;
  invoiceReviewStatus: AdditionalPartInvoiceReviewStatus;
  status: AdditionalPartStatus;
};

type AttachmentDraft = {
  category: AttachmentCategory;
  description: string;
  target: string;
};

type JobDetailSection =
  | 'tasks'
  | 'parts'
  | 'purchaseOrders'
  | 'additionalParts'
  | 'attachments'
  | 'documents'
  | 'schedule';

type JobProgressStep =
  | 'invoice-paid'
  | 'parts-needed'
  | 'order-placed'
  | 'in-transit'
  | 'parts-received'
  | 'labels-printed'
  | 'parts-pulled'
  | 'complete';

type JobPartPoRef = {
  poId: string;
  orderStatus: string;
  line: PurchaseOrderLine;
};

@Component({
  selector: 'app-job-detail',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    UiInput,
    PageBackButtonComponent,
    CompanySwitcherComponent,
    UserMenuComponent,
    VendorPickerComponent
  ],
  templateUrl: './job-detail.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./job-detail.component.scss']
})
export default class JobDetailComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly notificationsApi = inject(NotificationsApiService);
  private readonly router = inject(Router);
  private readonly jobDetailService = inject(JobDetailService);
  private readonly additionalPartsApi = inject(AdditionalPartsApiService);
  private readonly attachmentsApi = inject(AttachmentsApiService);
  private readonly jobTasksApi = inject(JobTasksApiService);
  private readonly purchaseOrdersApi = inject(PurchaseOrdersApiService);
  private readonly auth = inject(AuthService);
  private subscription?: Subscription;

  readonly loading = signal(false);
  readonly savingAdditionalPart = signal(false);
  readonly savingAttachment = signal(false);
  readonly savingTask = signal(false);
  readonly savingPurchaseOrder = signal(false);
  readonly additionalPartMessage = signal('');
  readonly attachmentMessage = signal('');
  readonly taskMessage = signal('');
  readonly error = signal('');
  readonly detail = signal<JobDetailPayload | null>(null);
  readonly tasks = signal<JobTask[]>([]);
  readonly showAdditionalPartForm = signal(false);
  readonly currentQuery = signal<JobDetailQuery>({});
  readonly additionalPartDraft = signal<AdditionalPartDraft>(this.emptyAdditionalPartDraft());
  readonly attachmentDraft = signal<AttachmentDraft>({ category: 'document', description: '', target: 'job:' });
  readonly selectedAttachmentFile = signal<File | null>(null);
  readonly openSections = signal<Set<JobDetailSection>>(new Set(['parts']));

  ngOnInit(): void {
    this.subscription = this.route.queryParamMap.subscribe(params => {
      const query: JobDetailQuery = {
        jobId: this.text(params.get('jobId')),
        jobNumber: this.text(params.get('jobNumber')),
        needId: this.text(params.get('needId')),
        scheduleId: this.text(params.get('scheduleId')),
        workItemId: this.text(params.get('workItemId')),
        invoiceId: this.text(params.get('invoiceId')),
        invoiceLineItemId: this.text(params.get('invoiceLineItemId'))
      };
      this.currentQuery.set(query);
      this.load(query);
    });
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
  }

  load(query: JobDetailQuery): void {
    this.loading.set(true);
    this.error.set('');
    this.jobDetailService.load(query).subscribe({
      next: detail => {
        this.detail.set(detail);
        this.notificationsApi.acknowledgeView([
          { type: 'job', id: detail.jobId },
          ...[...detail.invoices, ...detail.quotes].map(({ document }) => ({ type: document.documentType, id: document.id, number: document.invoiceNumber })),
          ...detail.workItems.map(item => ({ type: 'workitem' as const, id: item.id }))
        ]);
        this.loading.set(false);
        this.ensureAndLoadTasks(detail);
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not load job detail.'));
        this.loading.set(false);
      }
    });
  }

  ensureAndLoadTasks(detail: JobDetailPayload): void {
    if (detail.installDate && detail.parts.length) {
      this.jobTasksApi.ensurePartsTasks(this.taskContextPayload(detail)).subscribe({
        next: res => this.tasks.set(Array.isArray(res?.tasks) ? res.tasks : []),
        error: () => this.loadTasksOnly(detail)
      });
      return;
    }
    this.loadTasksOnly(detail);
  }

  loadTasksOnly(detail: JobDetailPayload): void {
    this.jobTasksApi.list({
      jobId: detail.jobId,
      jobNumber: detail.jobNumber,
      scheduleId: detail.schedules[0]?.id || detail.query.scheduleId || '',
      workItemId: detail.workItems[0]?.id || detail.query.workItemId || '',
      status: 'all'
    }).subscribe({
      next: res => this.tasks.set(Array.isArray(res?.tasks) ? res.tasks : []),
      error: () => this.tasks.set([])
    });
  }

  toggleAdditionalPartForm(): void {
    this.showAdditionalPartForm.set(!this.showAdditionalPartForm());
    if (this.showAdditionalPartForm()) {
      this.additionalPartDraft.set({
        ...this.emptyAdditionalPartDraft(),
        billingStatus: this.defaultBillingStatus(this.detail())
      });
    }
  }

  isSectionOpen(section: JobDetailSection): boolean {
    return this.openSections().has(section);
  }

  toggleSection(section: JobDetailSection): void {
    const next = new Set(this.openSections());
    if (next.has(section)) {
      next.delete(section);
    } else {
      next.add(section);
    }
    this.openSections.set(next);
  }

  openSection(section: JobDetailSection): void {
    if (this.openSections().has(section)) return;
    this.openSections.set(new Set([...this.openSections(), section]));
  }

  sectionToggleLabel(section: JobDetailSection): string {
    return this.isSectionOpen(section) ? 'Hide Details' : 'Show Details';
  }

  setAdditionalPartDraft<K extends keyof AdditionalPartDraft>(field: K, value: AdditionalPartDraft[K]): void {
    this.additionalPartDraft.set({
      ...this.additionalPartDraft(),
      [field]: value
    });
  }

  setAdditionalPartVendor(selection: { vendorId: string; vendorName: string }): void {
    this.additionalPartDraft.set({
      ...this.additionalPartDraft(),
      vendorId: selection.vendorId,
      vendor: selection.vendorName
    });
  }

  addAdditionalPart(): void {
    const detail = this.detail();
    if (!detail) return;
    const draft = this.additionalPartDraft();
    const partName = this.text(draft.partName || draft.sku);
    if (!partName) {
      this.error.set('Enter a part name or SKU for the additional part.');
      return;
    }

    const payload: AdditionalPartPayload = {
      ...this.jobContextPayload(detail),
      partName,
      sku: draft.sku,
      vendorId: draft.vendorId,
      vendor: draft.vendor,
      description: draft.description,
      quantity: this.toNumber(draft.quantity, 1),
      cost: this.toNumber(draft.cost, 0),
      markup: this.toNumber(draft.markup, 0),
      customerPrice: this.toNumber(draft.customerPrice, 0),
      reasonNotes: draft.reasonNotes,
      approvalStatus: draft.approvalStatus,
      billingStatus: draft.billingStatus,
      invoiceReviewStatus: draft.invoiceReviewStatus,
      status: draft.status,
      addedBy: this.currentUserName(),
      addedById: this.currentUserId()
    };

    this.savingAdditionalPart.set(true);
    this.additionalPartMessage.set('');
    this.error.set('');
    this.additionalPartsApi.create(payload).subscribe({
      next: () => {
        this.additionalPartMessage.set('Additional part added.');
        this.showAdditionalPartForm.set(false);
        this.additionalPartDraft.set(this.emptyAdditionalPartDraft());
        this.savingAdditionalPart.set(false);
        this.load(this.currentQuery());
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not add additional part.'));
        this.savingAdditionalPart.set(false);
      }
    });
  }

  updateAdditionalPart(part: AdditionalPart, payload: AdditionalPartPayload, message = 'Additional part updated.'): void {
    if (!part.id) return;
    this.savingAdditionalPart.set(true);
    this.additionalPartMessage.set('');
    this.error.set('');
    this.additionalPartsApi.update(part.id, {
      ...part,
      ...payload
    }).subscribe({
      next: () => {
        this.additionalPartMessage.set(message);
        this.savingAdditionalPart.set(false);
        this.load(this.currentQuery());
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not update additional part.'));
        this.savingAdditionalPart.set(false);
      }
    });
  }

  markAdditionalPartReviewed(part: AdditionalPart): void {
    this.updateAdditionalPart(part, {
      invoiceReviewStatus: 'reviewed',
      reviewedBy: this.currentUserName(),
      reviewedById: this.currentUserId()
    }, 'Additional part marked reviewed.');
  }

  setAttachmentDraft<K extends keyof AttachmentDraft>(field: K, value: AttachmentDraft[K]): void {
    this.attachmentDraft.set({
      ...this.attachmentDraft(),
      [field]: value
    });
  }

  setAttachmentFile(input: HTMLInputElement): void {
    this.selectedAttachmentFile.set(input.files && input.files[0] ? input.files[0] : null);
  }

  async uploadAttachment(): Promise<void> {
    const detail = this.detail();
    const file = this.selectedAttachmentFile();
    if (!detail || !file) {
      this.error.set('Choose a file to upload.');
      return;
    }
    try {
      this.savingAttachment.set(true);
      this.attachmentMessage.set('');
      this.error.set('');
      const fileDataUrl = await this.attachmentsApi.fileToDataUrl(file);
      const payload = this.attachmentPayload(detail, file, fileDataUrl);
      this.attachmentsApi.upload(payload).subscribe({
        next: () => {
          this.attachmentMessage.set('Attachment uploaded.');
          this.selectedAttachmentFile.set(null);
          this.attachmentDraft.set({ category: 'document', description: '', target: 'job:' });
          this.savingAttachment.set(false);
          this.load(this.currentQuery());
        },
        error: err => {
          this.error.set(String(err?.error?.error || err?.message || 'Could not upload attachment.'));
          this.savingAttachment.set(false);
        }
      });
    } catch (err: any) {
      this.error.set(String(err?.message || 'Could not read attachment.'));
      this.savingAttachment.set(false);
    }
  }

  archiveAttachment(attachment: Attachment): void {
    if (!attachment.id) return;
    this.savingAttachment.set(true);
    this.attachmentMessage.set('');
    this.error.set('');
    this.attachmentsApi.archive(attachment.id).subscribe({
      next: () => {
        this.attachmentMessage.set('Attachment archived.');
        this.savingAttachment.set(false);
        this.load(this.currentQuery());
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not archive attachment.'));
        this.savingAttachment.set(false);
      }
    });
  }

  updateTaskComments(task: JobTask, comments: string): void {
    this.tasks.set(this.tasks().map(row => row.id === task.id ? { ...row, comments } : row));
  }

  updateTaskStatus(task: JobTask, status: JobTask['status']): void {
    this.saveTask(task, { status }, 'Task updated.');
  }

  completeTask(task: JobTask): void {
    this.savingTask.set(true);
    this.taskMessage.set('');
    this.error.set('');
    this.jobTasksApi.complete(task.id, {
      comments: task.comments || '',
      completedBy: this.currentUserName(),
      completedById: this.currentUserId()
    }).subscribe({
      next: () => {
        this.taskMessage.set('Task completed.');
        this.savingTask.set(false);
        const detail = this.detail();
        if (detail) this.loadTasksOnly(detail);
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not complete task.'));
        this.savingTask.set(false);
      }
    });
  }

  saveTask(task: JobTask, payload: JobTaskPayload, message: string): void {
    this.savingTask.set(true);
    this.taskMessage.set('');
    this.error.set('');
    this.jobTasksApi.update(task.id, {
      ...task,
      ...payload
    }).subscribe({
      next: () => {
        this.taskMessage.set(message);
        this.savingTask.set(false);
        const detail = this.detail();
        if (detail) this.loadTasksOnly(detail);
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not update task.'));
        this.savingTask.set(false);
      }
    });
  }

  needsAdditionalPartReview(job: JobDetailPayload): boolean {
    return job.additionalParts.some(part => part.invoiceReviewStatus !== 'reviewed');
  }

  isReceivedPart(part: JobDetailPart): boolean {
    return this.toNumber(part.qtyReceived, 0) > 0 || ['received', 'pulled', 'installed'].includes(this.statusClass(part.status));
  }

  receivedParts(job: JobDetailPayload): JobDetailPart[] {
    return (job.parts || []).filter(part => this.isReceivedPart(part));
  }

  printPartLabel(job: JobDetailPayload, part: JobDetailPart): void {
    this.openPrintWindow(
      `Part Label - ${this.escapeText(part.partName || 'Part')}`,
      this.printDocument('Part Label', this.partLabelsHtml(job, [part]), 'labels')
    );
  }

  printReceivedLabels(job: JobDetailPayload): void {
    const parts = this.receivedParts(job);
    if (!parts.length) return;
    this.openPrintWindow(
      `Part Labels - ${this.escapeText(job.jobNumber || job.customerName || 'Job')}`,
      this.printDocument('Part Labels', this.partLabelsHtml(job, parts), 'labels')
    );
  }

  printPullSheet(job: JobDetailPayload): void {
    this.openPrintWindow(
      `Pull Sheet - ${this.escapeText(job.jobNumber || job.customerName || 'Job')}`,
      this.printDocument('Pull Sheet', this.pullSheetHtml(job), 'sheet')
    );
  }

  printJobPacket(job: JobDetailPayload): void {
    this.openPrintWindow(
      `Job Packet - ${this.escapeText(job.jobNumber || job.customerName || 'Job')}`,
      this.printDocument('Technician Job Packet', this.jobPacketHtml(job), 'packet')
    );
  }

  orderableParts(job: JobDetailPayload): JobDetailPart[] {
    return (job.parts || []).filter(part => this.partNeedsPurchaseOrder(part));
  }

  createPurchaseOrderDraft(job: JobDetailPayload): void {
    const parts = this.orderableParts(job);
    if (!parts.length) {
      this.error.set('No job parts currently need a purchase order.');
      return;
    }
    const lines: PurchaseOrderLine[] = parts.map((part, index) => {
      const qty = Math.max(1, Math.ceil(this.toNumber(part.qtyNeeded, 0) - Math.max(this.toNumber(part.qtyOrdered, 0), this.toNumber(part.qtyReceived, 0))));
      return {
        lineId: `line-${index + 1}`,
        needId: part.id,
        itemId: part.relatedInventoryItemId,
        relatedInventoryItemId: part.relatedInventoryItemId,
        relatedInvoiceId: part.relatedInvoiceId,
        relatedInvoiceLineItemId: part.relatedInvoiceLineItemId,
        jobId: part.jobId || job.jobId,
        jobNumber: part.jobNumber || job.jobNumber,
        partName: part.partName,
        sku: part.sku,
        vendor: part.vendor,
        vendorId: part.vendorId,
        qty,
        qtyNeeded: part.qtyNeeded,
        qtyOrdered: part.qtyOrdered,
        qtyReceived: part.qtyReceived,
        unitCost: 0,
        note: part.note
      };
    });
    const supplier = this.text(lines.find(line => this.text(line.vendor))?.vendor) || 'Unassigned Supplier';
    this.savingPurchaseOrder.set(true);
    this.error.set('');
    this.purchaseOrdersApi.createDraft({ supplier, lines }).subscribe({
      next: res => {
        this.savingPurchaseOrder.set(false);
        const id = this.text(res?.order?.id);
        if (id) {
          void this.router.navigate(['/purchase-orders'], { queryParams: { id } });
          return;
        }
        this.load(this.currentQuery());
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not create purchase order draft.'));
        this.savingPurchaseOrder.set(false);
      }
    });
  }

  documentRoute(type: string, id: string): string[] {
    return [type === 'quote' ? '/quotes' : '/invoices', id];
  }

  poProgress(received: number, total: number): string {
    if (total <= 0) return 'No quantities';
    return `${this.formatQty(received)} / ${this.formatQty(total)} received`;
  }

  poLineProgress(line: PurchaseOrderLine): string {
    const received = this.toNumber(line.qtyReceived, 0);
    const total = Math.max(this.toNumber(line.qty, 0), this.toNumber(line.qtyNeeded, 0), received);
    if (total <= 0) return 'No quantities';
    return `${this.formatQty(received)} / ${this.formatQty(total)}`;
  }

  trackingUrl(value: unknown): string {
    const tracking = this.text(value);
    return tracking ? `https://www.google.com/search?q=${encodeURIComponent(`${tracking} tracking`)}` : '';
  }

  jobPrimaryStatusLabel(job: JobDetailPayload): string {
    if (this.openTaskCount() > 0) return 'Action needed';
    if (this.partsNeedingOrderCount(job) > 0) return 'Parts need ordering';
    if (job.installDate) return 'Scheduled';
    if (job.invoices.length) return 'Needs scheduling';
    return this.label(job.status || 'Open');
  }

  partsNeedingOrderCount(job: JobDetailPayload): number {
    return (job.parts || []).filter(part => {
      const status = this.statusClass(part.status);
      const needed = this.toNumber(part.qtyNeeded, 0);
      const ordered = this.toNumber(part.qtyOrdered, 0);
      const received = this.toNumber(part.qtyReceived, 0);
      if (['received', 'pulled', 'installed', 'returned'].includes(status)) return false;
      return status === 'quoted'
        || status === 'backordered'
        || needed > Math.max(ordered, received);
    }).length;
  }

  readyPartsCount(job: JobDetailPayload): number {
    return (job.parts || []).filter(part => this.isReceivedPart(part)).length;
  }

  openTaskCount(): number {
    return this.tasks().filter(task => task.status === 'open' || task.status === 'in_progress').length;
  }

  poSummaryLabel(job: JobDetailPayload): string {
    if (!job.purchaseOrders.length) return 'No vendor orders yet';
    const total = job.purchaseOrders.reduce((sum, po) => sum + this.toNumber(po.totalQty, 0), 0);
    const received = job.purchaseOrders.reduce((sum, po) => sum + this.toNumber(po.receivedQty, 0), 0);
    return `${this.formatQty(received)} / ${this.formatQty(total)} received`;
  }

  jobPartsStatusLabel(job: JobDetailPayload): string {
    if (!job.parts.length) return 'No job parts';
    if (job.parts.some(part => this.partWorkflowLabel(part) === 'Backordered')) return 'Backordered';
    if (job.parts.some(part => this.partWorkflowLabel(part) === 'Needs PO')) return 'Needs PO';
    if (job.parts.some(part => this.partWorkflowLabel(part) === 'Partially Received')) return 'Partially Received';
    if (job.parts.every(part => this.partWorkflowLabel(part) === 'Installed')) return 'Installed';
    if (job.parts.every(part => this.partWorkflowLabel(part).includes('Pulled'))) return 'Pulled / Ready for Install';
    if (job.parts.every(part => this.partWorkflowLabel(part).includes('Ready'))) return 'Ready to Pull';
    if (job.parts.some(part => this.partWorkflowLabel(part) === 'Ordered' || this.partWorkflowLabel(part) === 'In Transit')) return 'Ordered';
    return job.partsReadiness || 'Parts in progress';
  }

  jobNextActionLabel(job: JobDetailPayload): string {
    if (this.partsNeedingOrderCount(job) > 0) return 'Create or submit PO';
    if (job.parts.some(part => this.partWorkflowLabel(part) === 'Partially Received')) return 'Receive remaining parts';
    if (job.parts.some(part => this.partWorkflowLabel(part) === 'Ready to Pull')) return 'Pull received parts';
    if (!job.installDate) return 'Schedule install';
    if (this.openTaskCount() > 0) return 'Complete open job tasks';
    if (job.parts.length && job.parts.every(part => this.partWorkflowLabel(part).includes('Pulled'))) return 'Install parts';
    return 'Monitor job';
  }

  jobMainBlockerLabel(job: JobDetailPayload): string {
    const backordered = job.parts.find(part => this.partWorkflowLabel(part) === 'Backordered');
    if (backordered) return `${backordered.partName || 'Part'} is backordered`;
    const needsPo = job.parts.find(part => this.partWorkflowLabel(part) === 'Needs PO');
    if (needsPo) return `${needsPo.partName || 'Part'} needs a PO`;
    const partial = job.parts.find(part => this.partWorkflowLabel(part) === 'Partially Received');
    if (partial) return `${partial.partName || 'Part'} is partially received`;
    if (!job.installDate) return 'Install is not scheduled';
    if (this.openTaskCount() > 0) return `${this.openTaskCount()} open task(s)`;
    return 'No blocker';
  }

  readonly progressSteps: Array<{ id: JobProgressStep; label: string }> = [
    { id: 'invoice-paid', label: 'Invoice Paid' },
    { id: 'parts-needed', label: 'Parts Needed' },
    { id: 'order-placed', label: 'Order Placed' },
    { id: 'in-transit', label: 'In Transit' },
    { id: 'parts-received', label: 'Parts Received' },
    { id: 'labels-printed', label: 'Labels Printed' },
    { id: 'parts-pulled', label: 'Parts Pulled' },
    { id: 'complete', label: 'Installed / Complete' }
  ];

  isProgressStepActive(job: JobDetailPayload, step: JobProgressStep): boolean {
    const parts = job.parts || [];
    const hasPaidInvoice = (job.invoices || []).some(row => {
      const stage = this.statusClass(row.document.stage);
      return stage === 'completed' || stage === 'paid' || this.toNumber(row.document.paidAmount, 0) > 0;
    });
    const hasNeedsPo = parts.some(part => this.partWorkflowLabel(part) === 'Needs PO');
    const hasPo = job.purchaseOrders.length > 0 || parts.some(part => part.relatedPoIds.length > 0);
    const hasTracking = job.purchaseOrders.some(po => po.lines.some(line => this.text(line.trackingNumber || line.trackingStatus || line.etaDate || line.estimatedDeliveryDate)));
    const hasReceived = parts.some(part => this.toNumber(part.qtyReceived, 0) > 0);
    const allReceived = parts.length > 0 && parts.every(part => this.toNumber(part.qtyReceived, 0) >= this.toNumber(part.qtyNeeded, 0));
    const allPulled = parts.length > 0 && parts.every(part => this.toNumber(part.qtyPulled, 0) >= this.toNumber(part.qtyNeeded, 0));
    const allInstalled = parts.length > 0 && parts.every(part => this.toNumber(part.qtyInstalled, 0) >= this.toNumber(part.qtyNeeded, 0));
    const status = this.statusClass(job.status);

    if (step === 'invoice-paid') return hasPaidInvoice || !!parts.length;
    if (step === 'parts-needed') return hasNeedsPo;
    if (step === 'order-placed') return hasPo || parts.some(part => this.toNumber(part.qtyOrdered, 0) > 0);
    if (step === 'in-transit') return hasTracking;
    if (step === 'parts-received') return allReceived || hasReceived;
    if (step === 'labels-printed') return false;
    if (step === 'parts-pulled') return allPulled;
    return status === 'completed' || status === 'complete';
  }

  progressStepClass(job: JobDetailPayload, step: JobProgressStep): string {
    if (!this.isProgressStepActive(job, step)) return 'pending';
    if (step === 'parts-needed') return 'warning';
    if (step === 'in-transit' || step === 'order-placed') return 'active';
    return 'done';
  }

  documentStatusLabel(stage: unknown, type: 'quote' | 'invoice'): string {
    const value = this.statusClass(stage);
    if (value === 'draft') return 'Draft';
    if (value === 'sent') return type === 'quote' ? 'Sent for approval' : 'Sent for payment';
    if (value === 'accepted') return type === 'quote' ? 'Approved' : 'Accepted';
    if (value === 'completed') return type === 'quote' ? 'Converted' : 'Paid';
    if (value === 'declined') return type === 'quote' ? 'Declined' : 'Declined';
    if (value === 'canceled' || value === 'cancelled') return type === 'quote' ? 'Archived quote' : 'Canceled invoice';
    if (value === 'expired') return 'Expired';
    return this.label(value || 'Open');
  }

  formatCurrency(value: unknown): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 2
    }).format(this.toNumber(value, 0));
  }

  formatDate(value: unknown): string {
    const ts = Date.parse(String(value || ''));
    if (!Number.isFinite(ts)) return 'Not scheduled';
    return new Date(ts).toLocaleString();
  }

  formatShortDate(value: unknown): string {
    const ts = Date.parse(String(value || ''));
    if (!Number.isFinite(ts)) return 'None';
    return new Date(ts).toLocaleDateString();
  }

  formatOptionalDate(value: unknown): string {
    const raw = this.text(value);
    if (!raw) return '--';
    const ts = Date.parse(raw);
    return Number.isFinite(ts) ? new Date(ts).toLocaleDateString() : raw;
  }

  formatOptionalDateTime(value: unknown): string {
    const raw = this.text(value);
    if (!raw) return '--';
    const ts = Date.parse(raw);
    return Number.isFinite(ts) ? new Date(ts).toLocaleString() : raw;
  }

  formatQty(value: unknown): string {
    const numeric = this.toNumber(value, 0);
    return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
  }

  statusClass(value: unknown): string {
    return String(value || 'quoted').trim().toLowerCase();
  }

  partWorkflowLabel(part: JobDetailPart): string {
    const status = this.statusClass(part.status);
    const needed = this.toNumber(part.qtyNeeded, 0);
    const ordered = this.toNumber(part.qtyOrdered, 0);
    const received = this.toNumber(part.qtyReceived, 0);
    const pulled = this.toNumber(part.qtyPulled, 0);
    const installed = this.toNumber(part.qtyInstalled, 0);
    if (status === 'backordered') return 'Backordered';
    if (status === 'returned') return 'Returned';
    if (installed >= needed && needed > 0) return 'Installed';
    if (pulled >= needed && needed > 0) return 'Pulled / Ready for Install';
    if (received >= needed && needed > 0) return 'Ready to Pull';
    if (received > 0 && received < needed) return 'Partially Received';
    if (ordered > 0 || status === 'ordered') return this.partTrackingLabel(part) !== '--' ? 'In Transit' : 'Ordered';
    return 'Needs PO';
  }

  partPoStatusLabel(part: JobDetailPart): string {
    const label = this.partWorkflowLabel(part);
    if (label === 'Needs PO') return 'Needs PO';
    if (!part.relatedPoIds.length) return 'No PO';
    if (label === 'In Transit') return 'In Transit';
    if (label === 'Ordered') return 'Ordered';
    if (label === 'Partially Received') return 'Partially Received';
    if (label === 'Ready to Pull') return 'Received';
    return label;
  }

  partTrackingLabel(part: JobDetailPart): string {
    const line = this.relatedPoLineForPart(part);
    return this.text(line?.trackingNumber) || '--';
  }

  partTrackingStatusLabel(part: JobDetailPart): string {
    const line = this.relatedPoLineForPart(part);
    if (this.text(line?.trackingLastError)) return 'Tracking Error';
    if (this.text(line?.trackingStatus)) return this.text(line?.trackingStatus);
    return this.text(line?.trackingNumber) ? 'Not checked' : '--';
  }

  partEtaLabel(part: JobDetailPart): string {
    const line = this.relatedPoLineForPart(part);
    return this.text(line?.etaDate || line?.estimatedDeliveryDate) ? this.formatShortDate(line?.etaDate || line?.estimatedDeliveryDate) : '--';
  }

  partCarrierLabel(part: JobDetailPart): string {
    return this.text(this.relatedPoLineForPart(part)?.carrier) || '--';
  }

  partLastTrackingUpdateLabel(part: JobDetailPart): string {
    const line = this.relatedPoLineForPart(part);
    return this.formatOptionalDateTime(line?.trackingStatusUpdatedAt || line?.deliveredAt);
  }

  partTrackingError(part: JobDetailPart): string {
    return this.text(this.relatedPoLineForPart(part)?.trackingLastError);
  }

  partReceivedProgress(part: JobDetailPart): string {
    return `${this.formatQty(part.qtyReceived)} / ${this.formatQty(Math.max(this.toNumber(part.qtyNeeded, 0), this.toNumber(part.qtyOrdered, 0), this.toNumber(part.qtyReceived, 0)))}`;
  }

  partRemainingQty(part: JobDetailPart): number {
    const required = Math.max(this.toNumber(part.qtyNeeded, 0), this.toNumber(part.qtyOrdered, 0), this.toNumber(part.qtyReceived, 0));
    return Math.max(0, required - this.toNumber(part.qtyReceived, 0));
  }

  partNextActionLabel(part: JobDetailPart): string {
    const label = this.partWorkflowLabel(part);
    if (label === 'Needs PO') return 'Create PO';
    if (label === 'Ordered' || label === 'In Transit') return 'Receive part';
    if (label === 'Partially Received') return 'Receive remaining';
    if (label === 'Ready to Pull') return 'Pull part';
    if (label.includes('Pulled')) return 'Install part';
    if (label === 'Installed') return 'Complete';
    if (label === 'Backordered') return 'Follow up';
    return 'Review';
  }

  jobPurchaseOrderStatusLabel(po: JobDetailPayload['purchaseOrders'][number]): string {
    if (po.order.status === 'cancelled') return 'Cancelled';
    if (po.totalQty > 0 && po.receivedQty > 0 && po.receivedQty < po.totalQty) return 'Partially Received';
    if (po.order.status === 'received' || po.totalQty > 0 && po.receivedQty >= po.totalQty) return 'Received';
    const hasTracking = po.lines.some(line => this.text(line.trackingNumber || line.trackingStatus || line.etaDate || line.estimatedDeliveryDate));
    if (po.order.status === 'ordered') return hasTracking ? 'In Transit' : 'Ordered';
    return 'PO Draft';
  }

  partOrderStatusLabel(part: JobDetailPart): string {
    const ref = this.relatedPoLineRefForPart(part);
    if (!ref) return this.partPoStatusLabel(part);
    if (ref.orderStatus === 'draft') return 'PO Draft';
    if (ref.orderStatus === 'cancelled') return 'Cancelled';
    return this.partPoStatusLabel(part);
  }

  canSubmitOrderForPart(part: JobDetailPart): boolean {
    const ref = this.relatedPoLineRefForPart(part);
    return !!ref?.poId && ref.orderStatus === 'draft' && !this.savingPurchaseOrder();
  }

  submitOrderForPart(part: JobDetailPart): void {
    const ref = this.relatedPoLineRefForPart(part);
    if (!ref?.poId) return;
    this.savingPurchaseOrder.set(true);
    this.error.set('');
    this.purchaseOrdersApi.submit(ref.poId).subscribe({
      next: () => {
        this.savingPurchaseOrder.set(false);
        this.load(this.currentQuery());
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not mark this order placed.'));
        this.savingPurchaseOrder.set(false);
      }
    });
  }

  canRefreshPartTracking(part: JobDetailPart): boolean {
    const ref = this.relatedPoLineRefForPart(part);
    return !!ref?.poId && !!this.text(ref.line.lineId) && !!this.text(ref.line.trackingNumber) && !this.savingPurchaseOrder();
  }

  refreshPartTracking(part: JobDetailPart): void {
    const ref = this.relatedPoLineRefForPart(part);
    const lineId = this.text(ref?.line.lineId);
    const trackingNumber = this.text(ref?.line.trackingNumber);
    if (!ref?.poId || !lineId || !trackingNumber) return;
    this.savingPurchaseOrder.set(true);
    this.error.set('');
    this.purchaseOrdersApi.refreshTracking(ref.poId, [{
      lineId,
      trackingNumber,
      carrier: this.text(ref.line.carrier)
    }]).subscribe({
      next: () => {
        this.savingPurchaseOrder.set(false);
        this.load(this.currentQuery());
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not refresh package tracking.'));
        this.savingPurchaseOrder.set(false);
      }
    });
  }

  canReceivePart(part: JobDetailPart): boolean {
    const ref = this.relatedPoLineRefForPart(part);
    return !!ref?.poId
      && !!this.text(ref.line.lineId)
      && ref.orderStatus !== 'draft'
      && ref.orderStatus !== 'cancelled'
      && this.partRemainingQty(part) > 0
      && !this.savingPurchaseOrder();
  }

  receivePart(part: JobDetailPart): void {
    const ref = this.relatedPoLineRefForPart(part);
    const lineId = this.text(ref?.line.lineId);
    const qtyReceived = this.partRemainingQty(part);
    if (!ref?.poId || !lineId || qtyReceived <= 0) return;
    this.savingPurchaseOrder.set(true);
    this.error.set('');
    this.purchaseOrdersApi.receive(ref.poId, [{
      lineId,
      qtyReceived,
      orderNumber: ref.line.orderNumber,
      trackingNumber: ref.line.trackingNumber,
      carrier: ref.line.carrier,
      etaDate: ref.line.etaDate || ref.line.estimatedDeliveryDate,
      vendorInvoiceNumber: ref.line.vendorInvoiceNumber,
      note: ref.line.note
    }]).subscribe({
      next: () => {
        this.savingPurchaseOrder.set(false);
        this.load(this.currentQuery());
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not receive this part.'));
        this.savingPurchaseOrder.set(false);
      }
    });
  }

  openPurchaseOrderForPart(part: JobDetailPart): void {
    const id = this.relatedPoLineRefForPart(part)?.poId || part.relatedPoIds[0];
    if (id) void this.router.navigate(['/purchase-orders'], { queryParams: { id } });
  }

  private relatedPoLineForPart(part: JobDetailPart): PurchaseOrderLine | null {
    return this.relatedPoLineRefForPart(part)?.line || null;
  }

  private relatedPoLineRefForPart(part: JobDetailPart): JobPartPoRef | null {
    const partId = this.text(part.id);
    const sku = this.text(part.sku).toLowerCase();
    const poIds = new Set((part.relatedPoIds || []).map(id => this.text(id)).filter(Boolean));
    for (const po of this.detail()?.purchaseOrders || []) {
      if (poIds.size && !poIds.has(this.text(po.order.id))) continue;
      const match = po.lines.find(line => {
        const lineNeedId = this.text(line.needId);
        const lineSku = this.text(line.sku).toLowerCase();
        return lineNeedId && lineNeedId === partId || sku && lineSku && lineSku === sku;
      });
      if (match) return {
        poId: this.text(po.order.id),
        orderStatus: this.statusClass(po.order.status),
        line: match
      };
    }
    return null;
  }

  partWorkflowClass(part: JobDetailPart): string {
    const label = this.partWorkflowLabel(part).toLowerCase();
    if (label.includes('backordered') || label.includes('returned')) return 'backordered';
    if (label.includes('partially')) return 'partial';
    if (label.includes('ready') || label.includes('installed') || label.includes('pulled')) return 'received';
    if (label.includes('ordered') || label.includes('transit')) return 'ordered';
    return 'quoted';
  }

  label(value: unknown): string {
    return String(value || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  attachmentSourceLabel(attachment: Attachment): string {
    if (attachment.relatedPurchaseOrderId) return `Purchase order ${attachment.relatedPurchaseOrderId}`;
    if (attachment.relatedAdditionalPartId) return 'Additional part';
    if (attachment.relatedInventoryNeedId || attachment.jobPartId) return 'Job part';
    if (attachment.relatedVendorId) return 'Vendor';
    return 'Job';
  }

  formatBytes(value: unknown): string {
    const bytes = this.toNumber(value, 0);
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${Math.round(bytes)} B`;
  }

  dueStateClass(task: JobTask): string {
    if (task.status === 'completed' || task.status === 'cancelled') return task.status;
    const dueMs = Date.parse(String(task.dueDate || ''));
    if (!Number.isFinite(dueMs)) return 'normal';
    const now = Date.now();
    if (dueMs < now) return 'overdue';
    if (dueMs - now <= 2 * 24 * 60 * 60 * 1000) return 'due-soon';
    return 'normal';
  }

  dueStateLabel(task: JobTask): string {
    const state = this.dueStateClass(task);
    if (state === 'overdue') return 'Overdue';
    if (state === 'due-soon') return 'Due soon';
    if (state === 'completed') return 'Completed';
    if (state === 'cancelled') return 'Cancelled';
    return 'Scheduled';
  }

  private partLabelsHtml(job: JobDetailPayload, parts: JobDetailPart[]): string {
    return `
      <section class="label-grid">
        ${parts.map(part => `
          <article class="part-label">
            <div class="label-topline">
              <strong>${this.escapeText(job.customerName || 'Customer')}</strong>
              <span>${this.escapeText(job.jobNumber || job.jobId || 'Job')}</span>
            </div>
            <h2>${this.escapeText(part.partName || 'Part')}</h2>
            <dl>
              <div><dt>Vehicle</dt><dd>${this.escapeText(job.vehicle || 'Vehicle TBD')}</dd></div>
              <div><dt>Qty</dt><dd>${this.formatQty(part.qtyReceived || part.qtyNeeded || 1)}</dd></div>
              <div><dt>Vendor</dt><dd>${this.escapeText(part.vendor || 'No supplier')}</dd></div>
              <div><dt>SKU</dt><dd>${this.escapeText(part.sku || 'N/A')}</dd></div>
              <div><dt>Shelf/Bin</dt><dd>${this.escapeText(this.shelfBinForPart(part))}</dd></div>
              <div><dt>Install</dt><dd>${this.escapeText(this.formatShortDate(job.installDate))}</dd></div>
            </dl>
          </article>
        `).join('')}
      </section>
    `;
  }

  private pullSheetHtml(job: JobDetailPayload): string {
    const incomplete = this.partWarnings(job);
    return `
      ${this.jobPrintHeader(job, 'Day-Before Pull Sheet')}
      ${incomplete ? `<section class="print-warning">${this.escapeText(incomplete)}</section>` : ''}
      ${this.printNotesSection(job)}
      <section class="print-section">
        <h2>Parts To Pull</h2>
        ${this.partsTableHtml(job.parts || [], true)}
      </section>
      ${this.additionalPartsPrintSection(job)}
      ${this.tasksPrintSection()}
    `;
  }

  private jobPacketHtml(job: JobDetailPayload): string {
    return `
      ${this.jobPrintHeader(job, 'Technician Job Packet')}
      ${this.partWarnings(job) ? `<section class="print-warning">${this.escapeText(this.partWarnings(job))}</section>` : ''}
      ${this.printNotesSection(job)}
      <section class="print-grid">
        <article>
          <h2>Customer</h2>
          <dl class="print-dl">
            <div><dt>Name</dt><dd>${this.escapeText(job.customerName || 'Customer TBD')}</dd></div>
            <div><dt>Vehicle</dt><dd>${this.escapeText(job.vehicle || 'Vehicle TBD')}</dd></div>
            <div><dt>Install Date</dt><dd>${this.escapeText(this.formatDate(job.installDate))}</dd></div>
          </dl>
        </article>
        <article>
          <h2>Billing Summary</h2>
          ${this.documentSummaryHtml(job)}
        </article>
      </section>
      <section class="print-section">
        <h2>Parts</h2>
        ${this.partsTableHtml(job.parts || [], false)}
      </section>
      ${this.additionalPartsPrintSection(job)}
      <section class="print-section">
        <h2>Attachments</h2>
        ${this.attachmentListHtml(job)}
      </section>
      ${this.tasksPrintSection()}
    `;
  }

  private jobPrintHeader(job: JobDetailPayload, title: string): string {
    return `
      <header class="print-header">
        <div>
          <p>Pathflow</p>
          <h1>${this.escapeText(title)}</h1>
        </div>
        <dl>
          <div><dt>Job</dt><dd>${this.escapeText(job.jobNumber || job.jobId || 'Job')}</dd></div>
          <div><dt>Customer</dt><dd>${this.escapeText(job.customerName || 'Customer TBD')}</dd></div>
          <div><dt>Vehicle</dt><dd>${this.escapeText(job.vehicle || 'Vehicle TBD')}</dd></div>
          <div><dt>Install</dt><dd>${this.escapeText(this.formatDate(job.installDate))}</dd></div>
        </dl>
      </header>
    `;
  }

  private partsTableHtml(parts: JobDetailPart[], includePulled: boolean): string {
    if (!parts.length) return '<div class="empty-print">No job parts found.</div>';
    return `
      <table class="print-table">
        <thead>
          <tr>
            <th>Part</th>
            <th>Vendor</th>
            <th>SKU</th>
            <th>Need</th>
            <th>Received</th>
            ${includePulled ? '<th>Pulled</th>' : ''}
            <th>Shelf/Bin</th>
            <th>Status</th>
            <th>Warning</th>
          </tr>
        </thead>
        <tbody>
          ${parts.map(part => `
            <tr>
              <td><strong>${this.escapeText(part.partName || 'Part')}</strong><small>${this.escapeText(part.note || '')}</small></td>
              <td>${this.escapeText(part.vendor || 'No supplier')}</td>
              <td>${this.escapeText(part.sku || 'N/A')}</td>
              <td>${this.formatQty(part.qtyNeeded)}</td>
              <td>${this.formatQty(part.qtyReceived)}</td>
              ${includePulled ? `<td>${this.formatQty(part.qtyPulled)}</td>` : ''}
              <td>${this.escapeText(this.shelfBinForPart(part))}</td>
              <td>${this.escapeText(this.label(part.status))}</td>
              <td>${this.escapeText(this.partWarning(part))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  private additionalPartsPrintSection(job: JobDetailPayload): string {
    if (!job.additionalParts.length) return '';
    return `
      <section class="print-section">
        <h2>Additional Parts</h2>
        <table class="print-table">
          <thead>
            <tr>
              <th>Part</th>
              <th>Vendor</th>
              <th>Qty</th>
              <th>Status</th>
              <th>Approval</th>
              <th>Billing</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            ${job.additionalParts.map(part => `
              <tr>
                <td><strong>${this.escapeText(part.partName || 'Part')}</strong><small>SKU ${this.escapeText(part.sku || 'N/A')}</small></td>
                <td>${this.escapeText(part.vendor || 'No supplier')}</td>
                <td>${this.formatQty(part.quantity)}</td>
                <td>${this.escapeText(this.label(part.status))}</td>
                <td>${this.escapeText(this.label(part.approvalStatus))}</td>
                <td>${this.escapeText(this.label(part.billingStatus))}</td>
                <td>${this.escapeText(part.reasonNotes || part.description || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </section>
    `;
  }

  private tasksPrintSection(): string {
    const rows = this.tasks();
    if (!rows.length) return '';
    return `
      <section class="print-section">
        <h2>Tasks</h2>
        <table class="print-table">
          <thead><tr><th>Task</th><th>Role</th><th>Due</th><th>Status</th><th>Warning</th></tr></thead>
          <tbody>
            ${rows.map(task => `
              <tr>
                <td>${this.escapeText(task.title)}</td>
                <td>${this.escapeText(task.assignedRole || 'Inventory / Front Desk')}</td>
                <td>${this.escapeText(this.formatDate(task.dueDate))}</td>
                <td>${this.escapeText(this.label(task.status))}</td>
                <td>${this.escapeText(task.warning || '')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </section>
    `;
  }

  private printNotesSection(job: JobDetailPayload): string {
    const notes = [
      ...job.workItems.map(item => item.notes || item.message || item.title || ''),
      ...job.schedules.map(schedule => schedule.notes || ''),
      ...job.invoices.map(row => row.document.staffNote || row.document.customerNote || ''),
      ...job.quotes.map(row => row.document.staffNote || row.document.customerNote || '')
    ].map(value => String(value || '').trim()).filter(Boolean);
    if (!notes.length) return '';
    return `
      <section class="print-section">
        <h2>Job Notes</h2>
        <ul class="print-list">${notes.map(note => `<li>${this.escapeText(note)}</li>`).join('')}</ul>
      </section>
    `;
  }

  private documentSummaryHtml(job: JobDetailPayload): string {
    const documents = [...job.quotes, ...job.invoices];
    if (!documents.length) return '<div class="empty-print">No quote or invoice linked.</div>';
    return `
      <table class="print-table compact">
        <thead><tr><th>Doc</th><th>Status</th><th>Total</th></tr></thead>
        <tbody>
          ${documents.map(row => `
            <tr>
              <td>${this.escapeText(row.document.invoiceNumber || row.document.id)}</td>
              <td>${this.escapeText(this.label(row.document.stage))}</td>
              <td>${this.escapeText(this.formatCurrency(row.document.total))}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  private attachmentListHtml(job: JobDetailPayload): string {
    if (!job.attachments.length) return '<div class="empty-print">No attachments linked.</div>';
    return `
      <ul class="print-list">
        ${job.attachments.map(attachment => `
          <li>
            <strong>${this.escapeText(attachment.originalFileName || attachment.fileName)}</strong>
            ${this.escapeText(this.label(attachment.category))} · ${this.escapeText(this.attachmentSourceLabel(attachment))}
            ${attachment.description ? ` · ${this.escapeText(attachment.description)}` : ''}
          </li>
        `).join('')}
      </ul>
    `;
  }

  private partWarnings(job: JobDetailPayload): string {
    const warnings = (job.parts || []).map(part => this.partWarning(part)).filter(Boolean);
    return Array.from(new Set(warnings)).join(' ');
  }

  private partWarning(part: JobDetailPart): string {
    const status = this.statusClass(part.status);
    if (status === 'backordered') return 'Backordered';
    if (this.toNumber(part.qtyReceived, 0) > 0 && this.toNumber(part.qtyReceived, 0) < this.toNumber(part.qtyNeeded, 0)) return 'Partially received';
    if (this.toNumber(part.qtyReceived, 0) < this.toNumber(part.qtyNeeded, 0)) return 'Missing / not fully received';
    if (this.toNumber(part.qtyPulled, 0) < this.toNumber(part.qtyNeeded, 0)) return 'Not fully pulled';
    return '';
  }

  private partNeedsPurchaseOrder(part: JobDetailPart): boolean {
    const status = this.statusClass(part.status);
    if (['received', 'pulled', 'installed', 'returned'].includes(status)) return false;
    const needed = this.toNumber(part.qtyNeeded, 0);
    const ordered = this.toNumber(part.qtyOrdered, 0);
    const received = this.toNumber(part.qtyReceived, 0);
    return status === 'quoted'
      || status === 'backordered'
      || needed > Math.max(ordered, received);
  }

  private shelfBinForPart(_part: JobDetailPart): string {
    return 'N/A';
  }

  private printDocument(title: string, body: string, mode: 'labels' | 'sheet' | 'packet'): string {
    return `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>${this.escapeText(title)}</title>
          <style>${this.printCss(mode)}</style>
        </head>
        <body>${body}</body>
      </html>
    `;
  }

  private printCss(mode: 'labels' | 'sheet' | 'packet'): string {
    const labelPage = mode === 'labels' ? '@page { size: letter; margin: 0.35in; }' : '@page { size: letter; margin: 0.5in; }';
    return `
      ${labelPage}
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
      dl div { display: grid; grid-template-columns: 90px 1fr; gap: 8px; }
      dt { color: #6b7280; font-weight: 700; text-transform: uppercase; font-size: 10px; }
      dd { margin: 0; font-weight: 700; }
      .print-section { break-inside: avoid; margin: 18px 0; }
      .print-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin: 18px 0; }
      .print-warning { margin: 14px 0; padding: 10px 12px; border: 1px solid #f59e0b; background: #fffbeb; color: #92400e; font-weight: 800; }
      .print-table { width: 100%; border-collapse: collapse; }
      .print-table th, .print-table td { padding: 7px 8px; border: 1px solid #d1d5db; text-align: left; vertical-align: top; }
      .print-table th { background: #f3f4f6; color: #374151; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
      .print-table.compact th, .print-table.compact td { padding: 6px; }
      .print-list { margin: 0; padding-left: 18px; }
      .print-list li { margin-bottom: 6px; }
      .empty-print { padding: 10px; border: 1px dashed #d1d5db; color: #6b7280; }
      .label-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .part-label { min-height: 2.6in; padding: 14px; border: 2px solid #111827; break-inside: avoid; }
      .label-topline { display: flex; justify-content: space-between; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid #d1d5db; }
      .part-label h2 { margin: 12px 0; font-size: 20px; line-height: 1.15; }
      .part-label dl { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; margin: 0; }
      .part-label dl div { display: block; }
      .part-label dt { margin-bottom: 2px; }
      .part-label dd { font-size: 14px; }
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

  private jobContextPayload(detail: JobDetailPayload): AdditionalPartPayload {
    return {
      jobId: detail.jobId,
      jobNumber: detail.jobNumber,
      relatedScheduleId: detail.schedules[0]?.id || detail.query.scheduleId || '',
      relatedWorkItemId: detail.workItems[0]?.id || detail.query.workItemId || '',
      relatedQuoteId: detail.quotes[0]?.document.id || '',
      relatedInvoiceId: detail.invoices[0]?.document.id || detail.query.invoiceId || ''
    };
  }

  private taskContextPayload(detail: JobDetailPayload): JobTaskPayload {
    return {
      jobId: detail.jobId,
      jobNumber: detail.jobNumber,
      relatedScheduleId: detail.schedules[0]?.id || detail.query.scheduleId || '',
      relatedWorkItemId: detail.workItems[0]?.id || detail.query.workItemId || '',
      customerName: detail.customerName,
      vehicle: detail.vehicle,
      installDate: detail.installDate,
      assignedRole: 'Inventory / Front Desk',
      ownerRole: 'Inventory Manager',
      priority: 'normal',
      parts: detail.parts,
      additionalParts: detail.additionalParts
    };
  }

  private attachmentPayload(detail: JobDetailPayload, file: File, fileDataUrl: string): AttachmentUploadPayload {
    const draft = this.attachmentDraft();
    const payload: AttachmentUploadPayload = {
      jobId: detail.jobId,
      jobNumber: detail.jobNumber,
      scheduleId: detail.schedules[0]?.id || detail.query.scheduleId || '',
      workItemId: detail.workItems[0]?.id || detail.query.workItemId || '',
      fileName: file.name,
      originalFileName: file.name,
      contentType: file.type || 'application/octet-stream',
      fileDataUrl,
      category: draft.category,
      description: draft.description
    };
    const [type, id] = String(draft.target || 'job:').split(':');
    if (type === 'jobPart') {
      payload.relatedInventoryNeedId = id;
      payload.jobPartId = id;
    } else if (type === 'additionalPart') {
      payload.relatedAdditionalPartId = id;
    } else if (type === 'purchaseOrder') {
      payload.relatedPurchaseOrderId = id;
      const po = detail.purchaseOrders.find(row => row.order.id === id);
      payload.relatedVendorId = po?.order.vendorId || '';
    }
    return payload;
  }

  private defaultBillingStatus(detail: JobDetailPayload | null): AdditionalPartBillingStatus {
    if (!detail) return 'not_added';
    const invoice = detail.invoices[0]?.document;
    if (invoice) {
      const total = this.toNumber(invoice.total, 0);
      const paid = this.toNumber(invoice.paidAmount, 0);
      if (invoice.stage === 'completed' || !!invoice.paymentDate || (paid >= total && total > 0)) return 'payment_needed';
      return 'invoice_update_needed';
    }
    if (detail.quotes.length) return 'quote_update_needed';
    return 'not_added';
  }

  private emptyAdditionalPartDraft(): AdditionalPartDraft {
    return {
      partName: '',
      sku: '',
      vendorId: '',
      vendor: '',
      description: '',
      quantity: 1,
      cost: 0,
      markup: 0,
      customerPrice: 0,
      reasonNotes: '',
      approvalStatus: 'pending',
      billingStatus: 'not_added',
      invoiceReviewStatus: 'needs_review',
      status: 'requested'
    };
  }

  private currentUserName(): string {
    const user = this.auth.user();
    return this.text(user?.displayName || user?.email || 'Staff');
  }

  private currentUserId(): string {
    const user = this.auth.user();
    return this.text(user?.id || user?.email);
  }

  private text(value: unknown): string {
    return String(value || '').trim();
  }

  private toNumber(value: unknown, fallback = 0): number {
    const parsed = Number(String(value ?? '').replace(/[$,%\s]/g, '').replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
