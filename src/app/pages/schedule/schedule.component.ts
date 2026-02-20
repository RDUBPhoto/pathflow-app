import { Component, ViewChild, signal, computed, AfterViewInit, OnDestroy, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton,
  IonIcon, IonModal, IonItem, IonLabel, IonSelect, IonSelectOption,
  IonInput, IonTextarea, IonCheckbox, IonSpinner, IonToggle
} from '@ionic/angular/standalone';
import { ActivatedRoute } from '@angular/router';
import { DayPilot, DayPilotModule, DayPilotSchedulerComponent } from '@daypilot/daypilot-lite-angular';
import { addIcons } from 'ionicons';
import {
  settingsOutline,
  addOutline,
  trashOutline
} from 'ionicons/icons';
import { CustomersApi, Customer } from '../../services/customers-api.service';
import { ScheduleApi, ScheduleItem } from '../../services/schedule-api.service';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { AppSettingsApiService } from '../../services/app-settings-api.service';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { formatLocalDateTime, toLocalDateTimeInput, toLocalDateTimeStorage } from '../../utils/datetime-local';

type UICustomer = Customer & {
  vehicleYear?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleColor?: string;
};

type Bay = { id: string; name: string };
type ScheduleSettings = {
  bays: Bay[];
  openHour: number;
  closeHour: number;
  showWeekends: boolean;
  holidays: string[];
  federalYear: number;
  federalInitialized: boolean;
};
const SCHEDULE_SETTINGS_KEY = 'schedule.settings';

@Component({
  selector: 'app-schedule',
  standalone: true,
  imports: [
    CommonModule, FormsModule, DayPilotModule,
    IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton,
    IonIcon, IonModal, IonItem, IonLabel, IonSelect, IonSelectOption,
    IonInput, IonTextarea, IonCheckbox, IonSpinner, IonToggle,
    UserMenuComponent,
    PageBackButtonComponent,
    CompanySwitcherComponent
  ],
  templateUrl: './schedule.component.html',
  styleUrls: ['./schedule.component.scss']
})
export default class ScheduleComponent implements AfterViewInit, OnDestroy {
  @ViewChild('scheduler') scheduler?: DayPilotSchedulerComponent;
  @ViewChild('scheduleShell', { read: ElementRef }) scheduleShell?: ElementRef<HTMLElement>;

  loading = signal(false);
  status = signal('');
  customers = signal<UICustomer[]>([]);
  items = signal<ScheduleItem[]>([]);

  resources = signal<DayPilot.ResourceData[]>([]);
  events = signal<DayPilot.EventData[]>([]);

  editorOpen = signal(false);
  editorId = signal<string | null>(null);
  editorStart = signal('');
  editorEnd = signal('');
  editorResource = signal('');
  editorCustomerId = signal<string | null>(null);
  editorBlocked = signal(false);
  editorTitle = signal('');
  editorNotes = signal('');
  editorParts = signal('');
  editorRepeatEvery = signal(0);
  editorRepeatCount = signal(1);

  settingsOpen = signal(false);
  settingsBays = signal<Bay[]>([]);
  settingsOpenHour = signal(7);
  settingsCloseHour = signal(16);
  settingsShowWeekends = signal(false);
  settingsHolidays = signal<string[]>([]);
  settingsFederalYear = signal(new Date().getFullYear());
  federalHolidayList = signal<{ date: string; name: string }[]>([]);
  newHolidayDate = signal('');
  pendingCustomerId: string | null = null;
  readonly openHourOptions = Array.from({ length: 24 }, (_, hour) => ({
    value: hour,
    label: this.formatHourLabel(hour)
  }));
  readonly closeHourOptions = Array.from({ length: 24 }, (_, index) => {
    const hour = index + 1;
    return {
      value: hour,
      label: hour === 24 ? '12:00 AM (next day)' : this.formatHourLabel(hour)
    };
  });

  customersById = computed(() => {
    const map: Record<string, UICustomer> = {};
    for (const c of this.customers()) map[c.id] = c;
    return map;
  });

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
    rowHeaderWidth: 110,
    headerHeight: 40,
    rowMarginTop: 10,
    rowMarginBottom: 10,
    eventHeight: 60,
    heightSpec: 'Fixed',
    height: 600,
    onTimeRangeSelected: args => {
      if (this.isHoliday(args.start)) {
        this.status.set('Closed for holiday');
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
        resource: String(args.resource)
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
        notes: data.tags?.notes || '',
        partRequests: Array.isArray(data.tags?.partRequests) ? data.tags.partRequests : []
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
        <div class="evt-title">${this.escapeHtml(String(args.data.text || ''))}</div>
        <div class="evt-time">${timeLabel}</div>
      `;
      if (tags.isBlocked) {
        args.data.backColor = '#2f343a';
        args.data.fontColor = '#ffffff';
      } else if (tags.vehicleColor) {
        args.data.barColor = tags.vehicleColor;
      }
    }
  };

  constructor(
    private customersApi: CustomersApi,
    private scheduleApi: ScheduleApi,
    private settingsApi: AppSettingsApiService,
    private route: ActivatedRoute
  ) {
    addIcons({
      'settings-outline': settingsOutline,
      'add-outline': addOutline,
      'trash-outline': trashOutline
    });
    this.applySettings(this.defaultSettings());
    this.loadPersistedSettings();
    this.loadAll();
    this.route.queryParamMap.subscribe(params => {
      const id = params.get('customerId');
      if (id) {
        this.pendingCustomerId = id;
        this.tryOpenFromQuery();
      }
    });
  }

  ngAfterViewInit() {
    this.updateSchedulerHeight();
    if (this.scheduleShell?.nativeElement) {
      this.resizeObserver = new ResizeObserver(() => this.updateSchedulerHeight());
      this.resizeObserver.observe(this.scheduleShell.nativeElement);
    }
  }

  ngOnDestroy() {
    if (this.resizeObserver && this.scheduleShell?.nativeElement) {
      this.resizeObserver.unobserve(this.scheduleShell.nativeElement);
      this.resizeObserver.disconnect();
    }
    this.resizeObserver = null;
  }

  private resizeObserver: ResizeObserver | null = null;

  private updateSchedulerHeight() {
    const shell = this.scheduleShell?.nativeElement;
    if (!shell) return;
    const height = Math.max(420, shell.clientHeight);
    const rows = Math.max(1, this.resources().length);
    const header = this.config.headerHeight ?? 40;
    const timeHeaderRows = this.config.timeHeaders?.length ?? 1;
    const timeHeaderHeight = 26 * timeHeaderRows;
    const available = Math.max(240, height - header - timeHeaderHeight - 12);
    const rowHeight = Math.max(80, Math.floor(available / rows));
    const eventHeight = Math.max(40, rowHeight - ((this.config.rowMarginTop ?? 0) + (this.config.rowMarginBottom ?? 0)));
    shell.style.setProperty('--row-height', `${rowHeight}px`);
    this.config.height = height;
    this.config.eventHeight = eventHeight;
    if (this.scheduler?.control) {
      this.scheduler.control.update({ height, heightSpec: 'Fixed', eventHeight });
    }
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
      federalInitialized: false
    };
  }

  private loadPersistedSettings(): void {
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

  private persistSettings(s: ScheduleSettings) {
    this.settingsApi.setValue(SCHEDULE_SETTINGS_KEY, s).subscribe({ error: () => {} });
  }

  private applySettings(s: ScheduleSettings) {
    this.settingsBays.set(s.bays);
    this.settingsOpenHour.set(s.openHour);
    this.settingsCloseHour.set(s.closeHour);
    this.settingsShowWeekends.set(s.showWeekends);
    this.settingsHolidays.set(s.holidays);
    this.settingsFederalYear.set(s.federalYear);
    const fed = this.getUsFederalHolidays(s.federalYear);
    this.federalHolidayList.set(fed);
    if (!s.federalInitialized && fed.length) {
      const merged = Array.from(new Set([...s.holidays, ...fed.map(f => f.date)])).sort();
      s.holidays = merged;
      s.federalInitialized = true;
      this.settingsHolidays.set(merged);
      this.persistSettings(s);
    }

    const resources = s.bays.map(b => ({ id: b.id, name: b.name }));
    this.resources.set(resources);
    this.config.resources = resources;
    this.config.businessBeginsHour = s.openHour;
    this.config.businessEndsHour = s.closeHour;
    this.config.businessWeekends = s.showWeekends;
    this.config.days = s.showWeekends ? 7 : 5;

    if (this.scheduler?.control) {
      this.scheduler.control.update({
        resources,
        businessBeginsHour: s.openHour,
        businessEndsHour: s.closeHour,
        businessWeekends: s.showWeekends,
        days: s.showWeekends ? 7 : 5
      });
    }
    this.updateSchedulerHeight();
  }

  private loadAll() {
    this.loading.set(true);
    this.customersApi.list().subscribe({
      next: cs => {
        this.customers.set(cs as UICustomer[]);
        this.scheduleApi.list().subscribe({
          next: items => {
            this.items.set(items);
            this.refreshEvents();
            this.tryOpenFromQuery();
            this.loading.set(false);
          },
          error: () => { this.status.set('Load schedule error'); this.loading.set(false); }
        });
      },
      error: () => { this.status.set('Load customers error'); this.loading.set(false); }
    });
  }

  private refreshEvents() {
    this.reconcileResourcesWithItems();
    const map = this.customersById();
    const list: DayPilot.EventData[] = [];
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
          partRequests: Array.isArray(it.partRequests) ? it.partRequests : [],
          vehicleColor: cust?.vehicleColor || ''
        }
      });
    }
    this.events.set(list);
  }

  private tryOpenFromQuery() {
    if (!this.pendingCustomerId) return;
    if (!this.resources().length) return;
    const slot = this.defaultSlot();
    this.openEditor({
      id: null,
      start: slot.start,
      end: slot.end,
      resource: slot.resource,
      customerId: this.pendingCustomerId,
      isBlocked: false,
      title: '',
      notes: ''
    });
    this.pendingCustomerId = null;
  }

  private defaultSlot(): { start: string; end: string; resource: string } {
    const openHour = this.settingsOpenHour();
    const closeHour = this.settingsCloseHour();
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

  private vehicleLabel(c: UICustomer): string {
    const parts = [c.vehicleYear, c.vehicleMake, c.vehicleModel].filter(Boolean);
    return parts.join(' ');
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
    partRequests?: Array<{ partName: string; qty: number; vendorHint?: string; sku?: string; note?: string }>;
  }) {
    this.editorId.set(data.id);
    this.editorStart.set(toLocalDateTimeInput(data.start));
    this.editorEnd.set(toLocalDateTimeInput(data.end));
    this.editorResource.set(data.resource);
    this.editorCustomerId.set(data.customerId || null);
    this.editorBlocked.set(!!data.isBlocked);
    this.editorTitle.set(data.title || '');
    this.editorNotes.set(data.notes || '');
    this.editorParts.set(this.formatPartRequestsForEditor(data.partRequests || []));
    this.editorRepeatEvery.set(0);
    this.editorRepeatCount.set(1);
    this.editorOpen.set(true);
  }

  closeEditor() {
    this.editorOpen.set(false);
  }

  saveEditor() {
    const start = toLocalDateTimeStorage(this.editorStart());
    const end = toLocalDateTimeStorage(this.editorEnd());
    const resource = this.editorResource();
    const isBlocked = this.editorBlocked();
    const customerId = isBlocked ? '' : (this.editorCustomerId() || '');
    const title = isBlocked ? this.editorTitle().trim() : '';
    const notes = this.editorNotes().trim();
    const partRequests = isBlocked ? [] : this.parsePartRequestsFromEditor(this.editorParts());
    const repeatEvery = Math.max(0, Number(this.editorRepeatEvery()) || 0);
    const repeatCount = Math.max(1, Number(this.editorRepeatCount()) || 1);

    if (!start || !end || !resource) {
      this.status.set('Start, end, and bay are required.');
      return;
    }

    if (Date.parse(start) >= Date.parse(end)) {
      this.status.set('End must be after start.');
      return;
    }

    const base = { start, end, resource, customerId, isBlocked, title, notes, partRequests };
    const id = this.editorId();

    if (id) {
      this.scheduleApi.update({ id, ...base }).subscribe({
        next: () => { this.loadAll(); this.editorOpen.set(false); this.status.set('Saved'); },
        error: () => this.status.set('Save error')
      });
      return;
    }

    const createOne = (s: string, e: string) =>
      this.scheduleApi.create({ ...base, start: s, end: e }).subscribe({
        next: () => { this.loadAll(); },
        error: () => this.status.set('Save error')
      });

    createOne(start, end);

    if (repeatEvery > 0 && repeatCount > 1) {
      const s0 = new DayPilot.Date(start);
      const e0 = new DayPilot.Date(end);
      for (let i = 1; i < repeatCount; i++) {
        const offset = repeatEvery * i;
        const s = s0.addDays(offset);
        const e = e0.addDays(offset);
        createOne(s.toString(), e.toString());
      }
    }

    this.editorOpen.set(false);
    this.status.set('Saved');
  }

  deleteEditor() {
    const id = this.editorId();
    if (!id) { this.editorOpen.set(false); return; }
    if (!window.confirm('Delete this appointment?')) return;
    this.scheduleApi.delete(id).subscribe({
      next: () => { this.loadAll(); this.editorOpen.set(false); this.status.set('Deleted'); },
      error: () => this.status.set('Delete error')
    });
  }

  private updateEventTime(id: string, start: DayPilot.Date, end: DayPilot.Date, resource: string) {
    this.scheduleApi.update({ id, start: start.toString(), end: end.toString(), resource: String(resource) }).subscribe({
      next: () => { this.loadAll(); },
      error: () => this.status.set('Update error')
    });
  }

  openSettings() {
    const current: ScheduleSettings = {
      bays: this.settingsBays(),
      openHour: this.settingsOpenHour(),
      closeHour: this.settingsCloseHour(),
      showWeekends: this.settingsShowWeekends(),
      holidays: this.settingsHolidays(),
      federalYear: this.settingsFederalYear(),
      federalInitialized: true
    };
    this.applySettings(current);
    this.settingsOpen.set(true);
  }

  addBay() {
    const id = `bay-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const bays = [...this.settingsBays(), { id, name: `Bay ${this.settingsBays().length + 1}` }];
    this.settingsBays.set(bays);
    this.applySettingsPreview();
  }

  removeBay(id: string) {
    const bays = this.settingsBays().filter(b => b.id !== id);
    this.settingsBays.set(bays);
    this.applySettingsPreview();
  }

  addHoliday() {
    const d = (this.newHolidayDate() || '').trim();
    if (!d) return;
    const list = Array.from(new Set([...this.settingsHolidays(), d])).sort();
    this.settingsHolidays.set(list);
    this.newHolidayDate.set('');
  }

  removeHoliday(d: string) {
    this.settingsHolidays.set(this.settingsHolidays().filter(x => x !== d));
  }

  saveSettings() {
    const openHour = Math.min(23, Math.max(0, Number(this.settingsOpenHour()) || 0));
    let closeHour = Math.min(24, Math.max(1, Number(this.settingsCloseHour()) || 1));
    if (closeHour <= openHour) {
      closeHour = Math.min(24, openHour + 1);
    }
    const s: ScheduleSettings = {
      bays: this.settingsBays().map(b => ({ id: b.id, name: (b.name || '').trim() || b.id })),
      openHour,
      closeHour,
      showWeekends: !!this.settingsShowWeekends(),
      holidays: this.settingsHolidays(),
      federalYear: this.settingsFederalYear(),
      federalInitialized: true
    };
    this.persistSettings(s);
    this.applySettings(s);
    this.settingsOpen.set(false);
  }

  private applySettingsPreview() {
    const resources = this.settingsBays().map(b => ({ id: b.id, name: b.name }));
    this.resources.set(resources);
    this.config.resources = resources;
    if (this.scheduler?.control) {
      this.scheduler.control.update({ resources });
    }
    this.updateSchedulerHeight();
  }

  private isHoliday(date: DayPilot.Date): boolean {
    const key = date.toString('yyyy-MM-dd');
    return this.settingsHolidays().includes(key);
  }

  onSettingsOpenHourChange(value: unknown): void {
    const hour = Math.min(23, Math.max(0, Number(value) || 0));
    this.settingsOpenHour.set(hour);
    if (this.settingsCloseHour() <= hour) {
      this.settingsCloseHour.set(Math.min(24, hour + 1));
    }
  }

  onSettingsCloseHourChange(value: unknown): void {
    const hour = Math.min(24, Math.max(1, Number(value) || 1));
    this.settingsCloseHour.set(hour);
  }

  updateFederalYear(value: string | number) {
    const year = Math.max(1900, Math.min(2100, Number(value) || new Date().getFullYear()));
    this.settingsFederalYear.set(year);
    this.federalHolidayList.set(this.getUsFederalHolidays(year));
  }

  toggleFederalHoliday(date: string, checked: boolean) {
    if (checked) {
      this.settingsHolidays.set(Array.from(new Set([...this.settingsHolidays(), date])).sort());
    } else {
      this.settingsHolidays.set(this.settingsHolidays().filter(d => d !== date));
    }
  }

  applyFederalHolidays() {
    const list = this.federalHolidayList().map(h => h.date);
    this.settingsHolidays.set(Array.from(new Set([...this.settingsHolidays(), ...list])).sort());
  }

  private getUsFederalHolidays(year: number): { date: string; name: string }[] {
    const fixed = (month: number, day: number) => this.observeHoliday(new Date(Date.UTC(year, month - 1, day)));
    const nthWeekday = (month: number, weekday: number, n: number) => {
      const first = new Date(Date.UTC(year, month - 1, 1));
      const firstDay = first.getUTCDay();
      const offset = (weekday - firstDay + 7) % 7;
      const day = 1 + offset + (n - 1) * 7;
      return new Date(Date.UTC(year, month - 1, day));
    };
    const lastWeekday = (month: number, weekday: number) => {
      const last = new Date(Date.UTC(year, month, 0));
      const lastDay = last.getUTCDay();
      const offset = (lastDay - weekday + 7) % 7;
      const day = last.getUTCDate() - offset;
      return new Date(Date.UTC(year, month - 1, day));
    };

    const list = [
      { name: "New Year's Day", date: fixed(1, 1) },
      { name: "Martin Luther King Jr. Day", date: nthWeekday(1, 1, 3) },
      { name: "Washington’s Birthday", date: nthWeekday(2, 1, 3) },
      { name: "Memorial Day", date: lastWeekday(5, 1) },
      { name: "Juneteenth", date: fixed(6, 19) },
      { name: "Independence Day", date: fixed(7, 4) },
      { name: "Labor Day", date: nthWeekday(9, 1, 1) },
      { name: "Columbus Day", date: nthWeekday(10, 1, 2) },
      { name: "Veterans Day", date: fixed(11, 11) },
      { name: "Thanksgiving Day", date: nthWeekday(11, 4, 4) },
      { name: "Christmas Day", date: fixed(12, 25) }
    ];

    return list.map(h => ({ name: h.name, date: this.formatDate(h.date) }));
  }

  private observeHoliday(d: Date): Date {
    const day = d.getUTCDay();
    if (day === 0) return new Date(d.getTime() + 24 * 60 * 60 * 1000);
    if (day === 6) return new Date(d.getTime() - 24 * 60 * 60 * 1000);
    return d;
  }

  private formatDate(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  private formatHourLabel(hour: number): string {
    const normalized = ((Number(hour) % 24) + 24) % 24;
    const ampm = normalized >= 12 ? 'PM' : 'AM';
    const hour12 = normalized % 12 || 12;
    return `${hour12}:00 ${ampm}`;
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
    this.updateSchedulerHeight();
  }

  private formatPartRequestsForEditor(parts: Array<{ partName: string; qty: number; vendorHint?: string; sku?: string; note?: string }>): string {
    return (Array.isArray(parts) ? parts : [])
      .map(part => {
        const qty = Math.max(1, Number(part.qty) || 1);
        const name = String(part.partName || '').trim();
        if (!name) return '';
        const vendor = String(part.vendorHint || '').trim();
        const sku = String(part.sku || '').trim();
        const note = String(part.note || '').trim();
        const extras = [vendor, sku, note].filter(Boolean).join(' | ');
        return extras ? `${qty}x ${name} | ${extras}` : `${qty}x ${name}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  private parsePartRequestsFromEditor(text: string): Array<{ partName: string; qty: number; vendorHint?: string; sku?: string; note?: string }> {
    const rows = String(text || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    const out: Array<{ partName: string; qty: number; vendorHint?: string; sku?: string; note?: string }> = [];

    for (const line of rows) {
      const match = line.match(/^\s*(\d+)\s*[xX]\s+(.+?)(?:\s*\|\s*([^|]+))?(?:\s*\|\s*([^|]+))?(?:\s*\|\s*(.+))?$/);
      if (match) {
        const qty = Math.max(1, Number(match[1]) || 1);
        const partName = String(match[2] || '').trim();
        if (!partName) continue;
        out.push({
          partName,
          qty,
          vendorHint: String(match[3] || '').trim(),
          sku: String(match[4] || '').trim(),
          note: String(match[5] || '').trim()
        });
        continue;
      }
      out.push({
        partName: line,
        qty: 1,
        vendorHint: '',
        sku: '',
        note: ''
      });
    }

    return out.slice(0, 40);
  }

  private escapeHtml(input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

}
