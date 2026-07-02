import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
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
import { JobDetailPayload, JobDetailQuery, JobDetailService } from '../../services/job-detail.service';
import { JobTask, JobTaskPayload, JobTasksApiService } from '../../services/job-tasks-api.service';

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

@Component({
  selector: 'app-job-detail',
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
    IonItem,
    IonLabel,
    IonInput,
    IonButton,
    PageBackButtonComponent,
    CompanySwitcherComponent,
    UserMenuComponent,
    VendorPickerComponent
  ],
  templateUrl: './job-detail.component.html',
  styleUrls: ['./job-detail.component.scss']
})
export default class JobDetailComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly jobDetailService = inject(JobDetailService);
  private readonly additionalPartsApi = inject(AdditionalPartsApiService);
  private readonly attachmentsApi = inject(AttachmentsApiService);
  private readonly jobTasksApi = inject(JobTasksApiService);
  private readonly auth = inject(AuthService);
  private subscription?: Subscription;

  readonly loading = signal(false);
  readonly savingAdditionalPart = signal(false);
  readonly savingAttachment = signal(false);
  readonly savingTask = signal(false);
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

  documentRoute(type: string, id: string): string[] {
    return [type === 'quote' ? '/quotes' : '/invoices', id];
  }

  poProgress(received: number, total: number): string {
    if (total <= 0) return 'No quantities';
    return `${this.formatQty(received)} / ${this.formatQty(total)} received`;
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

  formatQty(value: unknown): string {
    const numeric = this.toNumber(value, 0);
    return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(2);
  }

  statusClass(value: unknown): string {
    return String(value || 'quoted').trim().toLowerCase();
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
