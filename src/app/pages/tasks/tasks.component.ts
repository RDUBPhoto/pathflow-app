import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../auth/auth.service';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { JobTask, JobTaskOrderPart, JobTaskStatus, JobTasksApiService } from '../../services/job-tasks-api.service';
import { PurchaseOrder, PurchaseOrderLine, PurchaseOrdersApiService } from '../../services/purchase-orders-api.service';

type TaskFilter = JobTaskStatus | 'all' | 'needs-action' | 'parts-needed' | 'waiting-parts' | 'ready-install';

@Component({
  selector: 'app-tasks',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    PageBackButtonComponent,
    CompanySwitcherComponent,
    UserMenuComponent
  ],
  templateUrl: './tasks.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./tasks.component.scss']
})
export default class TasksComponent implements OnInit {
  private readonly tasksApi = inject(JobTasksApiService);
  private readonly purchaseOrdersApi = inject(PurchaseOrdersApiService);
  private readonly auth = inject(AuthService);

  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly status = signal('');
  readonly statusFilter = signal<TaskFilter>('needs-action');
  readonly tasks = signal<JobTask[]>([]);
  readonly expandedPartsTaskIds = signal<Set<string>>(new Set());
  readonly visibleTasks = computed(() => {
    const filter = this.statusFilter();
    return this.tasks().filter(task => {
      if (filter === 'all') return true;
      if (filter === 'needs-action') return this.jobNeedsAction(task);
      if (filter === 'parts-needed') return this.jobPartsNeeded(task);
      if (filter === 'waiting-parts') return this.jobWaitingOnParts(task);
      if (filter === 'ready-install') return this.jobReadyForInstall(task);
      return task.status === filter;
    });
  });
  readonly needsActionCount = computed(() => this.tasks().filter(task => this.jobNeedsAction(task)).length);
  readonly partsNeededCount = computed(() => this.tasks().filter(task => this.jobPartsNeeded(task)).length);
  readonly waitingOnPartsCount = computed(() => this.tasks().filter(task => this.jobWaitingOnParts(task)).length);
  readonly readyForInstallCount = computed(() => this.tasks().filter(task => this.jobReadyForInstall(task)).length);
  readonly inProgressCount = computed(() => this.tasks().filter(task => task.status === 'in_progress').length);
  readonly completedCount = computed(() => this.tasks().filter(task => task.status === 'completed').length);

  ngOnInit(): void {
    this.loadTasks();
  }

  loadTasks(): void {
    this.loading.set(true);
    this.error.set('');
    this.tasksApi.list({ status: 'all' }).subscribe({
      next: res => {
        const tasks = Array.isArray(res?.tasks) ? res.tasks : [];
        this.purchaseOrdersApi.list().subscribe({
          next: poRes => {
            this.tasks.set(this.mergeTasksWithPurchaseOrders(tasks, Array.isArray(poRes?.items) ? poRes.items : []));
            this.loading.set(false);
          },
          error: () => {
            this.tasks.set(tasks);
            this.loading.set(false);
          }
        });
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not load tasks.'));
        this.loading.set(false);
      }
    });
  }

  setFilter(value: TaskFilter): void {
    this.statusFilter.set(value);
  }

  updateTaskComments(task: JobTask, comments: string): void {
    this.tasks.set(this.tasks().map(row => row.id === task.id ? { ...row, comments } : row));
  }

  completeTask(task: JobTask): void {
    this.saving.set(true);
    this.status.set('');
    this.error.set('');
    this.tasksApi.complete(task.id, {
      comments: task.comments || '',
      completedBy: this.currentUserName(),
      completedById: this.currentUserId()
    }).subscribe({
      next: () => {
        this.status.set('Task completed.');
        this.saving.set(false);
        this.loadTasks();
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not complete task.'));
        this.saving.set(false);
      }
    });
  }

  saveNotes(task: JobTask): void {
    this.saving.set(true);
    this.status.set('');
    this.error.set('');
    this.tasksApi.update(task.id, { ...task, comments: task.comments || '' }).subscribe({
      next: () => {
        this.status.set('Task notes saved.');
        this.saving.set(false);
        this.loadTasks();
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not save task notes.'));
        this.saving.set(false);
      }
    });
  }

  refreshPackageTracking(part: JobTaskOrderPart): void {
    const purchaseOrderId = String(part.purchaseOrderId || '').trim();
    const lineId = String(part.poLineId || '').trim();
    const trackingNumber = String(part.trackingNumber || '').trim();
    if (!purchaseOrderId || !lineId || !trackingNumber) {
      this.error.set('Tracking cannot be refreshed until the PO line has a tracking number.');
      return;
    }

    this.saving.set(true);
    this.status.set('');
    this.error.set('');
    this.purchaseOrdersApi.refreshTracking(purchaseOrderId, [{
      lineId,
      trackingNumber,
      carrier: String(part.carrier || '').trim()
    }]).subscribe({
      next: res => {
        const first = Array.isArray(res.tracking) ? res.tracking[0] : null;
        if (first?.ok) {
          this.status.set(`Package status refreshed${first.trackingStatus ? `: ${first.trackingStatus}` : ''}.`);
        } else {
          this.error.set(String(first?.error || 'Could not refresh package status.'));
        }
        this.saving.set(false);
        this.loadTasks();
      },
      error: err => {
        this.error.set(String(err?.error?.error || err?.message || 'Could not refresh package status.'));
        this.saving.set(false);
      }
    });
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

  partsForTask(task: JobTask): string[] {
    const warning = String(task.warning || '').trim();
    if (!warning) return [];
    const normalized = warning
      .replace(/^needs\s+order\s*:\s*/i, '')
      .replace(/^parts?\s+to\s+order\s*:\s*/i, '')
      .trim();
    if (!normalized || (normalized === warning && /invoice payment|line item/i.test(normalized))) return [];
    return normalized
      .split(/[,;\n]+/g)
      .map(part => part.trim().replace(/\.$/, '').replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  visiblePartsForTask(task: JobTask): string[] {
    const parts = this.partsForTask(task);
    return this.partsExpanded(task) ? parts : parts.slice(0, 4);
  }

  hiddenPartCount(task: JobTask): number {
    return Math.max(0, this.partsForTask(task).length - this.visiblePartsForTask(task).length);
  }

  orderPartsForTask(task: JobTask): JobTaskOrderPart[] {
    return Array.isArray(task.orderParts) ? task.orderParts : [];
  }

  displayOrderPartsForTask(task: JobTask): JobTaskOrderPart[] {
    const structured = this.orderPartsForTask(task);
    if (structured.length) return structured;
    return this.partsForTask(task).map((partName, index) => ({
      id: `${task.id}-fallback-${index}`,
      partName,
      qtyNeeded: 1,
      hasInventoryItem: false
    }));
  }

  visibleOrderPartsForTask(task: JobTask): JobTaskOrderPart[] {
    const parts = this.displayOrderPartsForTask(task);
    return this.partsExpanded(task) ? parts : parts.slice(0, 5);
  }

  hiddenOrderPartCount(task: JobTask): number {
    return Math.max(0, this.displayOrderPartsForTask(task).length - this.visibleOrderPartsForTask(task).length);
  }

  primaryPart(task: JobTask): JobTaskOrderPart {
    return this.displayOrderPartsForTask(task)[0] || { id: `${task.id}-empty`, qtyNeeded: 0 };
  }

  jobStatusLabel(task: JobTask): string {
    const parts = this.displayOrderPartsForTask(task);
    if (!parts.length) return this.label(task.status);
    if (parts.some(part => String(part.status || part.jobPartStatus || '').toLowerCase() === 'backordered')) return 'Backordered';
    if (parts.every(part => this.toNumber(part.qtyReceived, 0) >= Math.max(this.toNumber(part.qtyNeeded, 0), 1))) return 'Received';
    if (parts.some(part => String(part.trackingStatus || '').trim())) return this.trackingStatusLabel(parts.find(part => String(part.trackingStatus || '').trim()) || parts[0]);
    if (parts.some(part => String(part.trackingNumber || '').trim())) return 'In Transit';
    if (parts.some(part => ['ordered', 'partial'].includes(String(part.purchaseOrderStatus || part.poLineStatus || '').toLowerCase()))) return 'Ordered';
    if (parts.some(part => String(part.purchaseOrderId || '').trim())) return 'PO Draft';
    return 'Needs PO';
  }

  nextActionLabel(task: JobTask): string {
    const status = this.jobStatusLabel(task).toLowerCase();
    if (status === 'needs po') return 'Create a purchase order for the needed parts.';
    if (status === 'po draft') return 'Review vendor details and submit the purchase order.';
    if (status === 'ordered' || status === 'in transit') return 'Watch tracking and receive parts when they arrive.';
    if (status === 'received') return 'Parts are received. Pull parts before install.';
    if (status === 'backordered') return 'Resolve backordered or missing parts.';
    if (task.status === 'completed') return 'No open action.';
    return task.title || 'Review this job.';
  }

  partsSummary(task: JobTask): string {
    const parts = this.displayOrderPartsForTask(task);
    if (!parts.length) return 'No parts';
    const needed = parts.reduce((sum, part) => sum + Math.max(0, this.toNumber(part.qtyNeeded, 0)), 0);
    const received = parts.reduce((sum, part) => sum + Math.max(0, this.toNumber(part.qtyReceived, 0)), 0);
    return `${parts.length} part${parts.length === 1 ? '' : 's'} · ${this.formatQty(received)} / ${this.formatQty(needed)} received`;
  }

  currentJobStageLabel(task: JobTask): string {
    if (task.status === 'completed') return 'Completed';
    if (task.status === 'in_progress') return 'In Progress';
    const status = this.jobStatusLabel(task).toLowerCase();
    if (status === 'needs po') return 'Parts Needed';
    if (status === 'po draft') return 'PO Draft';
    if (status === 'ordered' || status === 'in transit' || status === 'tracking') return 'Waiting on Parts';
    if (status === 'received') return 'Ready for Install';
    if (status === 'backordered') return 'Blocked';
    return 'Active';
  }

  jobDateLabel(task: JobTask): string {
    if (task.relatedScheduleId && task.dueDate) return `Schedule checkpoint ${this.formatDate(task.dueDate)}`;
    if (task.relatedScheduleId) return 'Scheduled';
    return 'Install not scheduled';
  }

  blockerLabel(task: JobTask): string {
    const warning = this.jobWarning(task);
    if (warning) return warning;
    if (this.jobPartsNeeded(task)) return 'Parts need a vendor order.';
    if (this.jobWaitingOnParts(task)) return 'Waiting for ordered parts to arrive.';
    if (this.jobReadyForInstall(task)) return 'No blocker: parts are ready.';
    if (task.status === 'completed') return 'Complete';
    return 'No blocker';
  }

  jobNeedsAction(task: JobTask): boolean {
    if (task.status === 'completed' || task.status === 'cancelled') return false;
    return this.jobPartsNeeded(task)
      || this.jobWaitingOnParts(task)
      || this.jobReadyForInstall(task)
      || !!this.jobWarning(task)
      || task.status === 'open'
      || task.status === 'in_progress';
  }

  jobPartsNeeded(task: JobTask): boolean {
    const status = this.jobStatusLabel(task).toLowerCase();
    return status === 'needs po' || status === 'po draft';
  }

  jobWaitingOnParts(task: JobTask): boolean {
    const status = this.jobStatusLabel(task).toLowerCase();
    return status === 'ordered'
      || status === 'in transit'
      || status === 'tracking'
      || status === 'order placed'
      || status === 'backordered'
      || status === 'partially received';
  }

  jobReadyForInstall(task: JobTask): boolean {
    const status = this.jobStatusLabel(task).toLowerCase();
    return status === 'received' || status === 'delivered';
  }

  poSummary(task: JobTask): string {
    const parts = this.displayOrderPartsForTask(task);
    const poIds = new Set(parts.map(part => String(part.purchaseOrderId || '').trim()).filter(Boolean));
    if (!poIds.size) return 'No PO';
    const ordered = parts.filter(part => ['ordered', 'received', 'partial'].includes(String(part.purchaseOrderStatus || part.poLineStatus || '').toLowerCase())).length;
    if (ordered) return `${poIds.size} PO · order placed`;
    return `${poIds.size} PO draft`;
  }

  compactTrackingSummary(task: JobTask): string {
    const part = this.displayOrderPartsForTask(task).find(row =>
      String(row.trackingNumber || row.trackingStatus || row.etaDate || row.estimatedDeliveryDate || '').trim()
    );
    if (!part) return '--';
    const status = this.trackingStatusLabel(part);
    const tracking = this.trackingDisplay(part);
    const eta = this.etaDisplay(part);
    return [status, tracking !== '--' ? tracking : '', eta !== '--' ? `ETA ${eta}` : '']
      .filter(Boolean)
      .join(' · ');
  }

  jobWarning(task: JobTask): string {
    const parts = this.displayOrderPartsForTask(task);
    const backordered = parts.find(part => String(part.status || part.jobPartStatus || '').toLowerCase() === 'backordered');
    if (backordered) return `Backordered: ${backordered.partName || 'part'}`;
    const missing = parts.filter(part => this.toNumber(part.qtyReceived, 0) < this.toNumber(part.qtyNeeded, 0));
    if (missing.length && this.dueStateClass(task) === 'overdue') return `${missing.length} part${missing.length === 1 ? '' : 's'} still not received.`;
    return this.compactWarning(task);
  }

  primaryPurchaseOrderId(task: JobTask): string {
    return String(this.displayOrderPartsForTask(task).find(part => String(part.purchaseOrderId || '').trim())?.purchaseOrderId || '').trim();
  }

  orderPartsCost(task: JobTask): number {
    return this.displayOrderPartsForTask(task).reduce((sum, part) => {
      const qty = Math.max(0, this.toNumber(part.qtyNeeded, 0));
      const cost = Math.max(0, this.toNumber(part.unitCost, 0));
      const shipping = Math.max(0, this.toNumber(part.shipping, 0));
      return sum + (qty * cost) + shipping;
    }, 0);
  }

  inventoryPartQueryParams(part: JobTaskOrderPart): Record<string, string> {
    const params: Record<string, string> = { section: 'stock' };
    const itemId = String(part.relatedInventoryItemId || '').trim();
    if (itemId) {
      params['itemId'] = itemId;
      return params;
    }
    const search = String(part.sku || part.partName || '').trim();
    if (search) params['search'] = search;
    return params;
  }

  displayValue(value: unknown): string {
    const text = String(value ?? '').trim();
    return text || '--';
  }

  formatQty(value: unknown): string {
    const qty = this.toNumber(value, 0);
    if (!Number.isFinite(qty)) return '--';
    return Number.isInteger(qty) ? String(qty) : qty.toFixed(2).replace(/\.?0+$/, '');
  }

  formatCurrency(value: unknown): string {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD'
    }).format(this.toNumber(value, 0));
  }

  formatMoneyOrDash(value: unknown): string {
    const amount = this.toNumber(value, 0);
    return amount > 0 ? this.formatCurrency(amount) : '--';
  }

  externalUrl(value: unknown): string {
    const url = String(value || '').trim();
    if (!url) return '';
    return /^https?:\/\//i.test(url) ? url : `https://${url}`;
  }

  compactWebsite(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw) return '--';
    try {
      const parsed = new URL(this.externalUrl(raw));
      return parsed.hostname.replace(/^www\./i, '');
    } catch {
      return raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
    }
  }

  trackingUrl(value: unknown): string {
    const tracking = String(value || '').trim();
    return tracking ? `https://www.google.com/search?q=${encodeURIComponent(`${tracking} tracking`)}` : '';
  }

  trackingDisplay(part: JobTaskOrderPart): string {
    const tracking = String(part.trackingNumber || '').trim();
    if (!tracking) return '--';
    return tracking.length > 18 ? `${tracking.slice(0, 8)}...${tracking.slice(-6)}` : tracking;
  }

  trackingEmptyText(part: JobTaskOrderPart): string {
    if (String(part.purchaseOrderId || '').trim()) return 'Not saved';
    return '--';
  }

  orderDisplay(part: JobTaskOrderPart): string {
    return String(part.orderNumber || part.purchaseOrderId || '').trim() || '--';
  }

  etaDisplay(part: JobTaskOrderPart): string {
    const value = String(part.etaDate || part.estimatedDeliveryDate || '').trim();
    const ts = Date.parse(value);
    if (!value) return '--';
    return Number.isFinite(ts) ? new Date(ts).toLocaleDateString() : value;
  }

  receivedProgress(part: JobTaskOrderPart): string {
    const received = this.toNumber(part.qtyReceived, 0);
    const needed = Math.max(this.toNumber(part.qtyNeeded, 0), this.toNumber(part.qtyOrdered, 0), received);
    if (needed <= 0) return '--';
    return `${this.formatQty(received)} / ${this.formatQty(needed)}`;
  }

  trackingStatusLabel(part: JobTaskOrderPart): string {
    const received = this.toNumber(part.qtyReceived, 0);
    const needed = Math.max(this.toNumber(part.qtyNeeded, 0), this.toNumber(part.qtyOrdered, 0), received);
    const providerStatus = String(part.trackingStatus || '').trim();
    const poStatus = String(part.purchaseOrderStatus || '').trim().toLowerCase();
    const lineStatus = String(part.poLineStatus || '').trim().toLowerCase();
    if (needed > 0 && received >= needed) return 'Received';
    if (String(part.deliveredAt || '').trim() || providerStatus.toLowerCase() === 'delivered') return 'Delivered';
    if (providerStatus) return this.label(providerStatus);
    if (String(part.trackingNumber || '').trim()) return 'Tracking';
    if (poStatus === 'ordered' || lineStatus === 'ordered' || this.toNumber(part.qtyOrdered, 0) > 0) return 'Order placed';
    if (poStatus === 'draft' || lineStatus === 'draft' || String(part.purchaseOrderId || '').trim()) return 'PO draft';
    return 'Needs PO';
  }

  trackingHelpText(part: JobTaskOrderPart): string {
    if (String(part.trackingNumber || '').trim()) return '';
    if (String(part.purchaseOrderId || '').trim()) {
      return 'Open the PO, enter tracking, then Save or Submit PO.';
    }
    return '';
  }

  trackingStatusClass(part: JobTaskOrderPart): string {
    return this.trackingStatusLabel(part)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'needs-po';
  }

  canRefreshTracking(part: JobTaskOrderPart): boolean {
    return !!String(part.purchaseOrderId || '').trim()
      && !!String(part.poLineId || '').trim()
      && !!String(part.trackingNumber || '').trim();
  }

  hasPackageTracking(part: JobTaskOrderPart): boolean {
    return !!String([
      part.purchaseOrderId,
      part.orderNumber,
      part.trackingNumber,
      part.carrier,
      part.trackingStatus,
      part.etaDate,
      part.estimatedDeliveryDate,
      part.deliveredAt,
      part.trackingLastError
    ].join('')).trim();
  }

  packageUpdatedDisplay(part: JobTaskOrderPart): string {
    const value = String(part.trackingStatusUpdatedAt || part.deliveredAt || '').trim();
    if (!value) return '--';
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? new Date(ts).toLocaleString() : value;
  }

  trackingSummary(part: JobTaskOrderPart): string {
    return [
      part.carrier,
      part.trackingStatus,
      part.trackingLastError ? `Error: ${part.trackingLastError}` : '',
      part.trackingStatusUpdatedAt ? `Updated ${this.formatDate(part.trackingStatusUpdatedAt)}` : ''
    ].map(value => String(value || '').trim()).filter(Boolean).join(' · ');
  }

  partsExpanded(task: JobTask): boolean {
    return this.expandedPartsTaskIds().has(task.id);
  }

  togglePartsExpanded(task: JobTask): void {
    this.expandedPartsTaskIds.update(current => {
      const next = new Set(current);
      if (next.has(task.id)) next.delete(task.id);
      else next.add(task.id);
      return next;
    });
  }

  compactWarning(task: JobTask): string {
    const warning = String(task.warning || '').trim();
    if (!warning) return '';
    if (/product\/part line item\(s\) need ordering after invoice payment/i.test(warning)) return '';
    return warning;
  }

  filterLabel(): string {
    const filter = this.statusFilter();
    if (filter === 'all') return 'All Jobs';
    if (filter === 'needs-action') return 'Needs Action';
    if (filter === 'parts-needed') return 'Parts Needed';
    if (filter === 'waiting-parts') return 'Waiting on Parts';
    if (filter === 'ready-install') return 'Ready for Install';
    return this.label(filter);
  }

  emptyTitle(): string {
    return this.tasks().length ? 'No jobs match this view' : 'No active jobs yet';
  }

  emptyMessage(): string {
    if (this.tasks().length) {
      return 'Try another job filter or refresh the list to pull in newly generated work orders.';
    }
    return 'Paid jobs with linked parts and scheduled installs will appear here as active work orders.';
  }

  label(value: unknown): string {
    return String(value || '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase());
  }

  formatDate(value: unknown): string {
    const ts = Date.parse(String(value || ''));
    if (!Number.isFinite(ts)) return 'No due date';
    return new Date(ts).toLocaleString();
  }

  jobQuery(task: JobTask): Record<string, string> {
    const params: Record<string, string> = {};
    if (task.jobId) params['jobId'] = task.jobId;
    if (task.jobNumber) params['jobNumber'] = task.jobNumber;
    if (task.relatedScheduleId) params['scheduleId'] = task.relatedScheduleId;
    if (task.relatedWorkItemId) params['workItemId'] = task.relatedWorkItemId;
    return params;
  }

  trackTask(_index: number, task: JobTask): string {
    return task.id;
  }

  trackOrderPart(_index: number, part: JobTaskOrderPart): string {
    return part.id || part.inventoryNeedId || `${part.partName || 'part'}-${part.sku || ''}`;
  }

  private currentUserName(): string {
    const user = this.auth.user();
    return String(user?.displayName || user?.email || 'Staff').trim();
  }

  private currentUserId(): string {
    const user = this.auth.user();
    return String(user?.id || user?.email || '').trim();
  }

  private toNumber(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private mergeTasksWithPurchaseOrders(tasks: JobTask[], orders: PurchaseOrder[]): JobTask[] {
    if (!tasks.length || !orders.length) return tasks;
    return tasks.map(task => {
      const orderParts = Array.isArray(task.orderParts)
        ? task.orderParts.map(part => this.mergeOrderPartWithPurchaseOrders(part, orders))
        : task.orderParts;
      return { ...task, orderParts };
    });
  }

  private mergeOrderPartWithPurchaseOrders(part: JobTaskOrderPart, orders: PurchaseOrder[]): JobTaskOrderPart {
    const poId = String(part.purchaseOrderId || '').trim();
    const scopedOrders = poId ? orders.filter(order => order.id === poId) : orders;
    const rows = scopedOrders.flatMap(order => (order.lines || []).map(line => ({ order, line })));
    const match = rows.find(row => this.purchaseOrderLineMatchesPart(row.line, part))
      || (poId && rows.length === 1 ? rows[0] : null);
    if (!match) return part;

    const line = match.line;
    return {
      ...part,
      purchaseOrderId: match.order.id || part.purchaseOrderId,
      purchaseOrderStatus: match.order.status || part.purchaseOrderStatus,
      poLineId: String(line.lineId || part.poLineId || '').trim(),
      poLineStatus: String(line.status || part.poLineStatus || '').trim(),
      orderNumber: String(line.orderNumber || part.orderNumber || '').trim(),
      trackingNumber: String(line.trackingNumber || part.trackingNumber || '').trim(),
      carrier: String(line.carrier || part.carrier || '').trim(),
      trackingStatus: String(line.trackingStatus || part.trackingStatus || '').trim(),
      trackingStatusUpdatedAt: String(line.trackingStatusUpdatedAt || part.trackingStatusUpdatedAt || '').trim(),
      etaDate: String(line.etaDate || line.estimatedDeliveryDate || part.etaDate || part.estimatedDeliveryDate || '').trim(),
      estimatedDeliveryDate: String(line.estimatedDeliveryDate || part.estimatedDeliveryDate || '').trim(),
      deliveredAt: String(line.deliveredAt || part.deliveredAt || '').trim(),
      vendorInvoiceNumber: String(line.vendorInvoiceNumber || part.vendorInvoiceNumber || '').trim(),
      trackingLastError: String(line.trackingLastError || part.trackingLastError || '').trim()
    };
  }

  private purchaseOrderLineMatchesPart(line: PurchaseOrderLine, part: JobTaskOrderPart): boolean {
    if (!line || !part) return false;
    if (this.sameText(line.needId, part.inventoryNeedId) || this.sameText(line.needId, part.id)) return true;
    if (this.sameText(line.relatedInvoiceLineItemId, part.relatedInvoiceLineItemId)) return true;
    if (this.sameText(line.relatedInventoryItemId || line.itemId, part.relatedInventoryItemId)) return true;
    if (this.sameNormalizedText(line.sku, part.sku)) return true;
    return this.sameNormalizedText(line.partName, part.partName);
  }

  private sameText(a: unknown, b: unknown): boolean {
    const left = String(a || '').trim();
    const right = String(b || '').trim();
    return !!left && !!right && left === right;
  }

  private sameNormalizedText(a: unknown, b: unknown): boolean {
    const left = this.normalizeMatchText(a);
    const right = this.normalizeMatchText(b);
    return !!left && !!right && left === right;
  }

  private normalizeMatchText(value: unknown): string {
    return String(value || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }
}
