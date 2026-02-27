import { Component, Input, Output, EventEmitter, ViewChild, signal, computed, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonModal, IonHeader, IonToolbar, IonTitle, IonButtons, IonButton,
  IonContent, IonItem, IonLabel, IonSelect, IonSelectOption, IonInput,
  IonTextarea, IonCheckbox, IonSpinner, IonFooter
} from '@ionic/angular/standalone';
import { DayPilot, DayPilotModule, DayPilotSchedulerComponent } from '@daypilot/daypilot-lite-angular';
import { CustomersApi, Customer } from '../../../services/customers-api.service';
import { ScheduleApi, ScheduleItem } from '../../../services/schedule-api.service';
import { AppSettingsApiService } from '../../../services/app-settings-api.service';
import { formatLocalDateTime, toLocalDateTimeInput, toLocalDateTimeStorage } from '../../../utils/datetime-local';

type UICustomer = Customer & {
  vehicleYear?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleColor?: string;
};

type ScheduleSettings = {
  bays: { id: string; name: string }[];
  openHour: number;
  closeHour: number;
  showWeekends: boolean;
  holidays: string[];
  federalYear: number;
  federalInitialized: boolean;
};
const SCHEDULE_SETTINGS_KEY = 'schedule.settings';

@Component({
  selector: 'app-schedule-modal',
  standalone: true,
  imports: [
    CommonModule, FormsModule, DayPilotModule,
    IonModal, IonHeader, IonToolbar, IonTitle, IonButtons, IonButton,
    IonContent, IonItem, IonLabel, IonSelect, IonSelectOption, IonInput,
    IonTextarea, IonCheckbox, IonSpinner, IonFooter
  ],
  templateUrl: './schedule-modal.component.html',
  styleUrls: ['./schedule-modal.component.scss']
})
export default class ScheduleModalComponent implements OnDestroy {
  @Input() isOpen: boolean = false;
  @Input() customerId: string | null = null;

  @Output() closed = new EventEmitter<void>();
  @Output() saved = new EventEmitter<void>();

  @ViewChild('scheduler') scheduler?: DayPilotSchedulerComponent;
  private readonly statusAutoDismissMs = 5000;
  private statusDismissTimer: ReturnType<typeof setTimeout> | null = null;

  loading = signal(false);
  status = signal('');
  statusTone = signal<'success' | 'error' | ''>('');
  customers = signal<UICustomer[]>([]);
  items = signal<ScheduleItem[]>([]);
  events = signal<DayPilot.EventData[]>([]);
  resources = signal<DayPilot.ResourceData[]>([]);

  editorOpen = signal(false);
  editorId = signal<string | null>(null);
  editorStart = signal('');
  editorEnd = signal('');
  editorResource = signal('');
  editorCustomerId = signal<string | null>(null);
  editorBlocked = signal(false);
  editorTitle = signal('');
  editorNotes = signal('');
  editorError = signal('');
  private editorInitialSnapshot = signal('');
  readonly editorDirty = computed(() => this.editorSnapshotValue() !== this.editorInitialSnapshot());

  config: DayPilot.SchedulerConfig = {
    startDate: DayPilot.Date.today(),
    days: 5,
    scale: 'Hour',
    cellDuration: 30,
    cellWidth: 64,
    timeHeaders: [
      { groupBy: 'Day', format: 'dddd, MMM d' },
      { groupBy: 'Hour', format: 'h tt' }
    ],
    businessBeginsHour: 7,
    businessEndsHour: 16,
    businessWeekends: false,
    eventMoveHandling: 'Update',
    eventResizeHandling: 'Update',
    timeRangeSelectedHandling: 'Enabled',
    eventClickHandling: 'Enabled',
    eventTextWrappingEnabled: true,
    rowHeaderWidth: 140,
    headerHeight: 40,
    rowMarginTop: 10,
    rowMarginBottom: 10,
    eventHeight: 60,
    heightSpec: 'Max',
    height: 520,
    onTimeRangeSelected: args => {
      if (this.isHoliday(args.start)) {
        this.setStatusError('Closed for holiday.');
        return;
      }
      const dp = args.control;
      dp.clearSelection();
      const start = args.start;
      const end = args.end;
      const minEnd = start.addHours(4);
      const finalEnd = (end.getTime() - start.getTime()) < 4 * 60 * 60 * 1000 ? minEnd : end;
      this.openEditor({
        id: null,
        start: start.toString(),
        end: finalEnd.toString(),
        resource: String(args.resource),
        customerId: this.customerId || ''
      });
    },
    onEventClick: args => {
      const data = args.e.data as any;
      this.openEditor({
        id: String(data.id),
        start: data.start.toString(),
        end: data.end.toString(),
        resource: String(data.resource),
        customerId: data.tags?.customerId || '',
        isBlocked: !!data.tags?.isBlocked,
        title: data.tags?.title || '',
        notes: data.tags?.notes || ''
      });
    },
    onEventMoved: args => {
      this.updateEventTime(args.e.data.id as string, args.newStart, args.newEnd, String(args.newResource));
    },
    onEventResized: args => {
      this.updateEventTime(args.e.data.id as string, args.newStart, args.newEnd, String(args.e.data.resource));
    },
    onBeforeCellRender: args => {
      if (this.isHoliday(args.cell.start)) {
        args.cell.properties.backColor = '#2f343a';
        args.cell.properties.fontColor = '#ffffff';
        args.cell.properties.cssClass = 'holiday-cell';
      }
    },
    onBeforeEventRender: args => {
      const tags: any = args.data.tags || {};
      const start = new DayPilot.Date(args.data.start);
      const end = new DayPilot.Date(args.data.end);
      const timeLabel = `${start.toString('h:mm tt')}–${end.toString('h:mm tt')}`;
      args.data.html = `
        <div class="evt-content">
          <div class="evt-title">${this.escapeHtml(String(args.data.text || ''))}</div>
          <div class="evt-time">${timeLabel}</div>
        </div>
      `;
      if (tags.isBlocked) {
        args.data.backColor = '#2f343a';
        args.data.fontColor = '#ffffff';
      } else if (tags.vehicleColor) {
        args.data.barColor = tags.vehicleColor;
      }
    }
  };

  ngOnDestroy(): void {
    this.clearStatusTimer();
  }

  private settings: ScheduleSettings = this.defaultSettings();

  constructor(
    private customersApi: CustomersApi,
    private scheduleApi: ScheduleApi,
    private settingsApi: AppSettingsApiService
  ) {
    this.loadSettings();
  }

  ngOnChanges() {
    if (this.isOpen) {
      this.loadAll();
    }
  }

  close() {
    this.closed.emit();
  }

  private loadAll() {
    this.clearStatus();
    this.loading.set(true);
    this.customersApi.list().subscribe({
      next: cs => {
        this.customers.set(cs as UICustomer[]);
        this.scheduleApi.list().subscribe({
          next: items => {
            this.items.set(items || []);
            this.refreshEvents();
            this.loading.set(false);
            if (this.customerId) this.openEditorWithCustomer(this.customerId);
          },
          error: () => {
            this.loading.set(false);
            this.setStatusError('Could not load schedule.');
          }
        });
      },
      error: () => {
        this.loading.set(false);
        this.setStatusError('Could not load customers.');
      }
    });
  }

  private refreshEvents() {
    this.reconcileResourcesWithItems();
    const list: DayPilot.EventData[] = [];
    const map: Record<string, UICustomer> = {};
    for (const c of this.customers()) map[c.id] = c;
    for (const it of this.items()) {
      const cust = it.customerId ? map[it.customerId] : null;
      const vehicle = cust ? this.vehicleLabel(cust) : '';
      const text = it.isBlocked
        ? (it.title || 'Closed')
        : (cust ? `${cust.name || 'Unnamed'}${vehicle ? ' — ' + vehicle : ''}` : 'Unassigned');
      list.push({
        id: it.id,
        start: it.start,
        end: it.end,
        resource: it.resource,
        text,
        toolTip: it.notes || '',
        tags: {
          customerId: it.customerId || '',
          isBlocked: !!it.isBlocked,
          title: it.title || '',
          notes: it.notes || '',
          vehicleColor: cust?.vehicleColor || ''
        }
      });
    }
    this.events.set(list);
  }

  private vehicleLabel(c: UICustomer): string {
    const parts = [c.vehicleYear, c.vehicleMake, c.vehicleModel].filter(Boolean);
    return parts.join(' ');
  }

  private openEditorWithCustomer(id: string) {
    const slot = this.defaultSlot();
    this.openEditor({
      id: null,
      start: slot.start,
      end: slot.end,
      resource: slot.resource,
      customerId: id
    });
  }

  private openEditor(data: {
    id: string | null;
    start: string;
    end: string;
    resource: string;
    customerId?: string;
    isBlocked?: boolean;
    title?: string;
    notes?: string;
  }) {
    this.editorId.set(data.id);
    this.editorStart.set(toLocalDateTimeInput(data.start));
    this.editorEnd.set(toLocalDateTimeInput(data.end));
    this.editorResource.set(data.resource);
    this.editorCustomerId.set(data.customerId || null);
    this.editorBlocked.set(!!data.isBlocked);
    this.editorTitle.set(data.title || '');
    this.editorNotes.set(data.notes || '');
    this.editorError.set('');
    this.markEditorPristine();
    this.editorOpen.set(true);
  }

  saveEditor() {
    const validationMessage = this.editorValidationError();
    if (validationMessage) {
      this.editorError.set(validationMessage);
      this.setStatusError(validationMessage);
      return;
    }

    this.editorError.set('');
    const start = toLocalDateTimeStorage(this.editorStart());
    const end = toLocalDateTimeStorage(this.editorEnd());
    const resource = this.editorResource();
    const isBlocked = this.editorBlocked();
    const customerId = isBlocked ? '' : (this.editorCustomerId() || '');
    const title = isBlocked ? this.editorTitle().trim() : '';
    const notes = this.editorNotes().trim();

    const base = { start, end, resource, customerId, isBlocked, title, notes };
    const id = this.editorId();
    if (id) {
      this.scheduleApi.update({ id, ...base }).subscribe({
        next: () => {
          this.editorOpen.set(false);
          this.loadAll();
          this.saved.emit();
          this.setStatusSuccess('Appointment saved.');
        },
        error: () => {
          this.editorError.set('Could not save appointment. Try again.');
          this.setStatusError('Could not save appointment.');
        }
      });
      return;
    }
    this.scheduleApi.create(base).subscribe({
      next: () => {
        this.editorOpen.set(false);
        this.loadAll();
        this.saved.emit();
        this.setStatusSuccess('Appointment saved.');
      },
      error: () => {
        this.editorError.set('Could not save appointment. Try again.');
        this.setStatusError('Could not save appointment.');
      }
    });
  }

  deleteEditor() {
    const id = this.editorId();
    if (!id) { this.editorOpen.set(false); return; }
    if (!window.confirm('Delete this appointment?')) return;
    this.scheduleApi.delete(id).subscribe({
      next: () => {
        this.editorOpen.set(false);
        this.loadAll();
        this.saved.emit();
        this.setStatusSuccess('Appointment deleted.');
      },
      error: () => this.setStatusError('Could not delete appointment.')
    });
  }

  private updateEventTime(id: string, start: DayPilot.Date, end: DayPilot.Date, resource: string) {
    this.scheduleApi.update({ id, start: start.toString(), end: end.toString(), resource }).subscribe({
      next: () => { this.loadAll(); this.saved.emit(); },
      error: () => this.setStatusError('Could not update appointment.')
    });
  }

  private defaultSlot(): { start: string; end: string; resource: string } {
    const openHour = this.settings.openHour;
    const closeHour = this.settings.closeHour;
    const start = new Date();
    start.setMinutes(0, 0, 0);
    if (start.getHours() < openHour) {
      start.setHours(openHour, 0, 0, 0);
    } else if (start.getHours() >= closeHour) {
      start.setDate(start.getDate() + 1);
      start.setHours(openHour, 0, 0, 0);
    }
    const end = new Date(start.getTime() + 4 * 60 * 60 * 1000);
    if (end.getHours() > closeHour) end.setHours(closeHour, 0, 0, 0);
    const resource = (this.resources()[0]?.id || 'bay-1').toString();
    return {
      start: formatLocalDateTime(start),
      end: formatLocalDateTime(end),
      resource
    };
  }

  private isHoliday(date: DayPilot.Date): boolean {
    const key = date.toString('yyyy-MM-dd');
    return (this.settings.holidays || []).includes(key);
  }

  private defaultSettings(): ScheduleSettings {
    return {
      bays: [
        { id: 'bay-1', name: 'Two-Post Lift 1' },
        { id: 'bay-2', name: 'Two-Post Lift 2' },
        { id: 'bay-3', name: 'Two-Post Lift 3' },
        { id: 'bay-4', name: 'Two-Post Lift 4' },
        { id: 'bay-5', name: 'Four-Post Lift' }
      ],
      openHour: 7,
      closeHour: 16,
      showWeekends: false,
      holidays: [],
      federalYear: new Date().getFullYear(),
      federalInitialized: true
    };
  }

  private loadSettings() {
    this.applySettings(this.defaultSettings());
    this.settingsApi.getValue<ScheduleSettings>(SCHEDULE_SETTINGS_KEY).subscribe(value => {
      if (!value) return;
      this.applySettings(this.normalizeSettings(value));
    });
  }

  private normalizeSettings(value: unknown): ScheduleSettings {
    const parsed = value && typeof value === 'object' ? (value as Partial<ScheduleSettings>) : {};
    const base = this.defaultSettings();
    return {
      bays: Array.isArray(parsed.bays) && parsed.bays.length ? parsed.bays : base.bays,
      openHour: Number.isFinite(parsed.openHour) ? Number(parsed.openHour) : base.openHour,
      closeHour: Number.isFinite(parsed.closeHour) ? Number(parsed.closeHour) : base.closeHour,
      showWeekends: typeof parsed.showWeekends === 'boolean' ? parsed.showWeekends : base.showWeekends,
      holidays: Array.isArray(parsed.holidays) ? parsed.holidays.map(v => String(v || '')) : base.holidays,
      federalYear: Number.isFinite(parsed.federalYear) ? Number(parsed.federalYear) : base.federalYear,
      federalInitialized: typeof parsed.federalInitialized === 'boolean' ? parsed.federalInitialized : base.federalInitialized
    };
  }

  private applySettings(settings: ScheduleSettings): void {
    this.settings = settings;
    this.resources.set(settings.bays.map(b => ({ id: b.id, name: b.name })));
    this.config.resources = this.resources();
    this.config.businessBeginsHour = settings.openHour;
    this.config.businessEndsHour = settings.closeHour;
    this.config.businessWeekends = settings.showWeekends;
    this.config.days = settings.showWeekends ? 7 : 5;
  }

  private reconcileResourcesWithItems(): void {
    const baseResources = [...this.resources()];
    const seen = new Set(baseResources.map(resource => String(resource.id)));
    let changed = false;

    for (const item of this.items()) {
      const resourceId = String(item.resource || '').trim();
      if (!resourceId || seen.has(resourceId)) continue;
      seen.add(resourceId);
      baseResources.push({
        id: resourceId,
        name: `Unmapped (${resourceId})`
      });
      changed = true;
    }

    if (!changed) return;
    this.resources.set(baseResources);
    this.config.resources = baseResources;
    if (this.scheduler?.control) {
      this.scheduler.control.update({ resources: baseResources });
    }
  }

  editorValidationError(): string {
    const start = toLocalDateTimeStorage(this.editorStart());
    const end = toLocalDateTimeStorage(this.editorEnd());
    const resource = this.editorResource().trim();
    if (!start || !end || !resource) {
      return 'Start, end, and bay are required.';
    }
    if (Date.parse(start) >= Date.parse(end)) {
      return 'End must be after start.';
    }
    if (this.editorBlocked() && !this.editorTitle().trim()) {
      return 'Block label is required when blocking a bay.';
    }
    return '';
  }

  canSaveEditor(): boolean {
    return !this.editorValidationError() && this.editorDirty();
  }

  private editorSnapshotValue(): string {
    return JSON.stringify({
      id: this.editorId() || '',
      start: toLocalDateTimeStorage(this.editorStart()),
      end: toLocalDateTimeStorage(this.editorEnd()),
      resource: this.editorResource().trim(),
      customerId: this.editorBlocked() ? '' : String(this.editorCustomerId() || '').trim(),
      isBlocked: !!this.editorBlocked(),
      title: this.editorTitle().trim(),
      notes: this.editorNotes().trim()
    });
  }

  private markEditorPristine(): void {
    this.editorInitialSnapshot.set(this.editorSnapshotValue());
  }

  private escapeHtml(input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private clearStatus(): void {
    this.clearStatusTimer();
    this.status.set('');
    this.statusTone.set('');
  }

  private setStatusSuccess(message: string): void {
    this.status.set(message);
    this.statusTone.set('success');
    this.scheduleStatusDismiss();
  }

  private setStatusError(message: string): void {
    this.status.set(message);
    this.statusTone.set('error');
    this.scheduleStatusDismiss();
  }

  private scheduleStatusDismiss(): void {
    this.clearStatusTimer();
    this.statusDismissTimer = setTimeout(() => {
      this.statusDismissTimer = null;
      this.clearStatus();
    }, this.statusAutoDismissMs);
  }

  private clearStatusTimer(): void {
    if (!this.statusDismissTimer) return;
    clearTimeout(this.statusDismissTimer);
    this.statusDismissTimer = null;
  }
}
