import { CommonModule, CurrencyPipe, DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { IonButton, IonButtons, IonContent, IonHeader, IonTitle, IonToolbar } from '@ionic/angular/standalone';
import { firstValueFrom } from 'rxjs';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import {
  InvoiceDetail,
  InvoiceLineItem,
  InvoiceLineType,
  InvoiceStage,
  InvoicesDataService
} from '../../services/invoices-data.service';
import { Lane, LanesApi } from '../../services/lanes-api.service';
import { PaymentGatewaySettingsService } from '../../services/payment-gateway-settings.service';
import { WorkItem, WorkItemsApi } from '../../services/workitems-api.service';

type StatusTone = 'neutral' | 'success' | 'error';

@Component({
  selector: 'app-invoice-detail',
  standalone: true,
  imports: [
    CommonModule,
    CurrencyPipe,
    DatePipe,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonButton,
    IonContent,
    PageBackButtonComponent,
    CompanySwitcherComponent,
    UserMenuComponent
  ],
  templateUrl: './invoice-detail.component.html',
  styleUrls: ['./invoice-detail.component.scss']
})
export default class InvoiceDetailComponent {
  readonly lineItemsPageSize = 10;
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly invoicesData = inject(InvoicesDataService);
  private readonly paymentSettings = inject(PaymentGatewaySettingsService);
  private readonly lanesApi = inject(LanesApi);
  private readonly workItemsApi = inject(WorkItemsApi);

  readonly loading = signal(true);
  readonly saving = signal(false);
  readonly error = signal('');
  readonly status = signal('');
  readonly statusTone = signal<StatusTone>('neutral');
  readonly lineItemsPage = signal(1);

  readonly invoice = signal<InvoiceDetail | null>(null);
  private readonly baselineSnapshot = signal('');

  readonly stageOptions: InvoiceStage[] = ['draft', 'sent', 'accepted', 'declined', 'expired'];
  readonly paymentAvailability = this.paymentSettings.paymentLinkAvailability;

  readonly totals = computed(() => {
    const detail = this.invoice();
    const lineItems = detail?.lineItems || [];
    const subtotal = this.roundCurrency(lineItems.reduce((sum, line) => sum + line.lineSubtotal, 0));
    const taxTotal = this.roundCurrency(lineItems.reduce((sum, line) => sum + line.taxAmount, 0));
    const total = this.roundCurrency(subtotal + taxTotal);
    return { subtotal, taxTotal, total };
  });

  readonly hasChanges = computed(() => {
    const current = this.invoice();
    if (!current) return false;
    return this.snapshot(current) !== this.baselineSnapshot();
  });

  readonly canSave = computed(() => !!this.invoice() && this.hasChanges() && !this.saving());
  readonly lineItems = computed(() => this.invoice()?.lineItems || []);
  readonly lineItemsTotalPages = computed(() => Math.max(1, Math.ceil(this.lineItems().length / this.lineItemsPageSize)));
  readonly pagedLineItems = computed(() => {
    const page = Math.max(1, Math.min(this.lineItemsPage(), this.lineItemsTotalPages()));
    const start = (page - 1) * this.lineItemsPageSize;
    return this.lineItems().slice(start, start + this.lineItemsPageSize);
  });

  constructor() {
    this.route.paramMap.subscribe(params => {
      const id = String(params.get('id') || '').trim();
      this.loadInvoice(id);
    });
  }

  setStage(value: string): void {
    if (!this.isStage(value)) return;
    this.updateField('stage', value);
  }

  updateField<K extends keyof InvoiceDetail>(field: K, value: InvoiceDetail[K]): void {
    this.invoice.update(current => {
      if (!current) return current;
      return {
        ...current,
        [field]: value,
        updatedAt: new Date().toISOString()
      };
    });
    this.clearStatus();
  }

  togglePaymentLink(checked: boolean): void {
    const availability = this.paymentAvailability();
    if (checked && !availability.enabled) return;

    this.invoice.update(current => {
      if (!current) return current;
      const next: InvoiceDetail = {
        ...current,
        includePaymentLink: checked,
        updatedAt: new Date().toISOString()
      };

      if (!checked) {
        next.paymentProviderKey = '';
        next.paymentLinkUrl = '';
      } else if (availability.provider) {
        next.paymentProviderKey = availability.provider.key;
      }
      return next;
    });
    this.clearStatus();
  }

  addLineItem(type: InvoiceLineType = 'part'): void {
    this.invoice.update(current => {
      if (!current) return current;
      const line: InvoiceLineItem = this.recalculateLine({
        id: `li-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        type,
        code: '',
        description: '',
        quantity: 1,
        unitPrice: 0,
        taxRate: 0,
        lineSubtotal: 0,
        taxAmount: 0,
        lineTotal: 0
      });
      return {
        ...current,
        lineItems: [...current.lineItems, line],
        updatedAt: new Date().toISOString()
      };
    });
    this.clearStatus();
    this.lineItemsPage.set(this.lineItemsTotalPages());
  }

  removeLineItem(lineId: string): void {
    const id = String(lineId || '').trim();
    if (!id) return;
    this.invoice.update(current => {
      if (!current) return current;
      return {
        ...current,
        lineItems: current.lineItems.filter(line => line.id !== id),
        updatedAt: new Date().toISOString()
      };
    });
    this.clearStatus();
    this.lineItemsPage.update(value => Math.max(1, Math.min(value, this.lineItemsTotalPages())));
  }

  updateLineItemField(lineId: string, field: keyof InvoiceLineItem, rawValue: string): void {
    const id = String(lineId || '').trim();
    if (!id) return;

    this.invoice.update(current => {
      if (!current) return current;
      const nextLines = current.lineItems.map(line => {
        if (line.id !== id) return line;

        const nextLine: InvoiceLineItem = { ...line };
        if (field === 'type') {
          nextLine.type = rawValue === 'labor' ? 'labor' : 'part';
        } else if (field === 'quantity' || field === 'unitPrice' || field === 'taxRate') {
          const value = this.safeNumber(rawValue);
          (nextLine[field] as number) = value < 0 ? 0 : value;
        } else if (field === 'code' || field === 'description') {
          (nextLine[field] as string) = String(rawValue || '');
        }

        return this.recalculateLine(nextLine);
      });

      return {
        ...current,
        lineItems: nextLines,
        updatedAt: new Date().toISOString()
      };
    });
    this.clearStatus();
  }

  async save(): Promise<void> {
    const current = this.invoice();
    if (!current || !this.canSave()) return;

    const availability = this.paymentAvailability();
    if (current.includePaymentLink && !availability.enabled) {
      this.setStatus('Need to connect your payment provider', 'error');
      return;
    }

    this.saving.set(true);
    this.clearStatus();
    try {
      const previousStage = this.invoicesData.getInvoiceById(current.id)?.stage || current.stage;
      let next = this.cloneInvoice(current);
      next.lineItems = next.lineItems.map(line => this.recalculateLine(line));

      if (next.includePaymentLink && availability.provider) {
        next.paymentProviderKey = availability.provider.key;
        if (!String(next.paymentLinkUrl || '').trim()) {
          next.paymentLinkUrl =
            this.paymentSettings.createHostedPaymentLink(next.id, next.invoiceNumber) || next.paymentLinkUrl || '';
        }
      }

      if (!next.includePaymentLink) {
        next.paymentProviderKey = '';
        next.paymentLinkUrl = '';
      }

      const saved = this.invoicesData.saveInvoice(next);
      const autoCompleteOutcome = await this.autoCompleteWorkItemOnInvoiceAccepted(previousStage, saved);
      this.invoice.set(saved);
      this.baselineSnapshot.set(this.snapshot(saved));
      if (autoCompleteOutcome === 'completed') {
        this.setStatus(`${saved.invoiceNumber} saved. Work item moved to Completed.`, 'success');
      } else if (autoCompleteOutcome === 'failed') {
        this.setStatus(`${saved.invoiceNumber} saved. Could not auto-complete active work item.`, 'neutral');
      } else {
        this.setStatus(`${saved.invoiceNumber} saved.`, 'success');
      }
    } catch {
      this.setStatus('Could not save invoice.', 'error');
    } finally {
      this.saving.set(false);
    }
  }

  openAdminSettings(): void {
    void this.router.navigate(['/admin-settings']);
  }

  openInvoiceList(): void {
    void this.router.navigate(['/invoices']);
  }

  trackLineItem(_index: number, line: InvoiceLineItem): string {
    return line.id;
  }

  prevLineItemsPage(): void {
    this.lineItemsPage.update(value => Math.max(1, value - 1));
  }

  nextLineItemsPage(): void {
    this.lineItemsPage.update(value => Math.min(this.lineItemsTotalPages(), value + 1));
  }

  private loadInvoice(id: string): void {
    this.loading.set(true);
    this.error.set('');
    this.clearStatus();

    if (!id) {
      this.invoice.set(null);
      this.error.set('Invoice not found.');
      this.loading.set(false);
      return;
    }

    const found = this.invoicesData.getInvoiceById(id);
    if (!found) {
      this.invoice.set(null);
      this.error.set('Invoice not found.');
      this.loading.set(false);
      return;
    }

    this.invoice.set(found);
    this.baselineSnapshot.set(this.snapshot(found));
    this.lineItemsPage.set(1);
    this.loading.set(false);
  }

  private snapshot(invoice: InvoiceDetail): string {
    return JSON.stringify(invoice);
  }

  private cloneInvoice(invoice: InvoiceDetail): InvoiceDetail {
    return {
      ...invoice,
      lineItems: invoice.lineItems.map(line => ({ ...line })),
      timeline: invoice.timeline.map(entry => ({ ...entry }))
    };
  }

  private async autoCompleteWorkItemOnInvoiceAccepted(
    previousStage: InvoiceStage,
    saved: InvoiceDetail
  ): Promise<'completed' | 'failed' | 'noop'> {
    if (previousStage === 'accepted' || saved.stage !== 'accepted') return 'noop';

    const customerId = String(saved.customerId || '').trim();
    if (!customerId) return 'noop';

    try {
      const [lanes, allItems] = await Promise.all([
        firstValueFrom(this.lanesApi.list()),
        firstValueFrom(this.workItemsApi.list())
      ]);
      const completedLaneId = this.completedLaneId(lanes || []);
      if (!completedLaneId) return 'failed';

      const target = this.findActiveWorkItemForCustomer(allItems || [], lanes || [], customerId);
      if (!target) return 'noop';

      const nowIso = new Date().toISOString();
      const patch: Partial<WorkItem> & { id: string } = {
        id: target.id,
        laneId: completedLaneId,
        completedAt: nowIso,
        calendarOverrideAt: ''
      };
      Object.assign(patch, this.buildCompletionTimingPatch(target, nowIso));

      await firstValueFrom(this.workItemsApi.update(patch));
      return 'completed';
    } catch {
      return 'failed';
    }
  }

  private findActiveWorkItemForCustomer(
    allItems: WorkItem[],
    lanes: Lane[],
    customerId: string
  ): WorkItem | null {
    const lookup = customerId.trim().toLowerCase();
    if (!lookup) return null;

    const candidates = (allItems || []).filter(item => {
      const itemCustomer = String(item.customerId || '').trim().toLowerCase();
      if (!itemCustomer || itemCustomer !== lookup) return false;
      if (!String(item.checkedInAt || '').trim()) return false;
      if (String(item.completedAt || '').trim()) return false;
      return true;
    });
    if (!candidates.length) return null;

    const inProgress = candidates.filter(item => this.laneStageKey(this.findLaneById(lanes, item.laneId)) === 'inprogress');
    const ordered = (inProgress.length ? inProgress : candidates).sort(
      (a, b) => this.itemWorkSortTime(b) - this.itemWorkSortTime(a)
    );
    return ordered[0] || null;
  }

  private findLaneById(lanes: Lane[], laneId: string): Lane | null {
    if (!laneId) return null;
    return (lanes || []).find(lane => lane.id === laneId) || null;
  }

  private completedLaneId(lanes: Lane[]): string | null {
    const explicit = (lanes || []).find(lane => String(lane.stageKey || '').trim().toLowerCase() === 'completed');
    if (explicit?.id) return explicit.id;

    const inferred = (lanes || []).find(lane => /complete|completed|done|ready|pickup/.test(String(lane.name || '').toLowerCase()));
    return inferred?.id || null;
  }

  private laneStageKey(lane: Lane | null): string {
    const explicit = String(lane?.stageKey || '').trim().toLowerCase();
    if (explicit) return explicit;
    const name = String(lane?.name || '').trim().toLowerCase();
    if (!name) return 'custom';
    if (/in[- ]?progress|work in progress|progress/.test(name)) return 'inprogress';
    if (/complete|completed|done|pickup|ready/.test(name)) return 'completed';
    return 'custom';
  }

  private itemWorkSortTime(item: WorkItem): number {
    return Math.max(
      this.asMillis(item.checkedInAt),
      this.asMillis(item.updatedAt),
      this.asMillis(item.createdAt)
    );
  }

  private asMillis(value: string | null | undefined): number {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private elapsedMs(fromIso: string | null | undefined, toIso: string): number {
    const from = this.asMillis(fromIso);
    const to = this.asMillis(toIso);
    if (!from || !to || to <= from) return 0;
    return to - from;
  }

  private safeDuration(value: unknown): number {
    const duration = Number(value);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
  }

  private buildCompletionTimingPatch(item: WorkItem, nowIso: string): Partial<WorkItem> {
    const isPaused = !!item.isPaused || !!String(item.pausedAt || '').trim();
    const workIncrement = isPaused
      ? 0
      : this.elapsedMs(
          String(item.lastWorkResumedAt || '').trim() || String(item.checkedInAt || '').trim(),
          nowIso
        );
    const pauseIncrement = isPaused ? this.elapsedMs(item.pausedAt, nowIso) : 0;

    return {
      isPaused: false,
      pausedAt: '',
      lastWorkResumedAt: '',
      workDurationMs: this.safeDuration(item.workDurationMs) + workIncrement,
      pauseDurationMs: this.safeDuration(item.pauseDurationMs) + pauseIncrement
    };
  }

  private recalculateLine(line: InvoiceLineItem): InvoiceLineItem {
    const quantity = this.safeNumber(line.quantity, 0);
    const unitPrice = this.safeNumber(line.unitPrice, 0);
    const taxRate = this.safeNumber(line.taxRate, 0);
    const lineSubtotal = this.roundCurrency(quantity * unitPrice);
    const taxAmount = this.roundCurrency((lineSubtotal * taxRate) / 100);
    const lineTotal = this.roundCurrency(lineSubtotal + taxAmount);
    return {
      ...line,
      quantity,
      unitPrice,
      taxRate,
      lineSubtotal,
      taxAmount,
      lineTotal
    };
  }

  private safeNumber(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed;
  }

  private roundCurrency(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private isStage(value: string): value is InvoiceStage {
    return value === 'draft' || value === 'sent' || value === 'accepted' || value === 'declined' || value === 'expired';
  }

  private clearStatus(): void {
    this.status.set('');
    this.statusTone.set('neutral');
  }

  private setStatus(message: string, tone: StatusTone = 'neutral'): void {
    this.status.set(message);
    this.statusTone.set(tone);
  }
}
