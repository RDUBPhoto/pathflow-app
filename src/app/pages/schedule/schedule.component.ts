import { Component, ViewChild, signal, computed, AfterViewInit, OnDestroy, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton,
  IonIcon, IonModal, IonItem, IonLabel, IonSelect, IonSelectOption,
  IonInput, IonTextarea, IonCheckbox, IonSpinner, IonFooter
} from '@ionic/angular/standalone';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { DayPilot, DayPilotModule, DayPilotMonthComponent, DayPilotSchedulerComponent } from '@daypilot/daypilot-lite-angular';
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
import { UserScopedSettingsService } from '../../services/user-scoped-settings.service';

type UICustomer = Customer & {
  vehicleYear?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleColor?: string;
};

type Bay = { id: string; name: string };
type CalendarViewMode = 'day' | 'week' | 'month';
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
const SCHEDULE_VIEW_MODE_KEY = 'schedule.viewMode';
const SCHEDULE_VIEW_ANCHOR_KEY = 'schedule.viewStart';

@Component({
  selector: 'app-schedule',
  standalone: true,
  imports: [
    CommonModule, FormsModule, DayPilotModule,
    IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton,
    IonIcon, IonModal, IonItem, IonLabel, IonSelect, IonSelectOption,
    IonInput, IonTextarea, IonCheckbox, IonSpinner, IonFooter,
    UserMenuComponent,
    PageBackButtonComponent,
    CompanySwitcherComponent,
    RouterLink
  ],
  templateUrl: './schedule.component.html',
  styleUrls: ['./schedule.component.scss']
})
export default class ScheduleComponent implements AfterViewInit, OnDestroy {
  private readonly eventAccentPalette = [
    '#3b82f6',
    '#14b8a6',
    '#f97316',
    '#a855f7',
    '#eab308',
    '#06b6d4',
    '#ef4444',
    '#22c55e'
  ];
  private readonly weekMinCellWidth = 172;
  private readonly dayCellWidth = 72;
  private readonly monthMinCellHeight = 84;
  private readonly monthMaxCellHeight = 118;
  private readonly statusAutoDismissMs = 5000;
  private statusDismissTimer: ReturnType<typeof setTimeout> | null = null;
  private nowLineTimer: ReturnType<typeof setInterval> | null = null;
  private nowLineScrollEl: HTMLElement | null = null;
  private readonly onNowLineScroll = () => this.syncNowLine();

  @ViewChild('scheduler') scheduler?: DayPilotSchedulerComponent;
  @ViewChild('month') month?: DayPilotMonthComponent;
  @ViewChild('scheduleShell', { read: ElementRef }) scheduleShell?: ElementRef<HTMLElement>;

  loading = signal(false);
  status = signal('');
  statusTone = signal<'success' | 'error' | ''>('');
  customers = signal<UICustomer[]>([]);
  items = signal<ScheduleItem[]>([]);

  resources = signal<DayPilot.ResourceData[]>([]);
  events = signal<DayPilot.EventData[]>([]);
  monthEvents = signal<DayPilot.EventData[]>([]);

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
  editorError = signal('');
  private editorInitialSnapshot = signal('');

  settingsOpen = signal(false);
  settingsBays = signal<Bay[]>([]);
  settingsOpenHour = signal(7);
  settingsCloseHour = signal(16);
  settingsShowWeekends = signal(false);
  settingsHolidays = signal<string[]>([]);
  settingsFederalYear = signal(new Date().getFullYear());
  federalHolidayList = signal<{ date: string; name: string }[]>([]);
  newHolidayDate = signal('');
  settingsError = signal('');
  private settingsInitialSnapshot = signal('');
  showNowLine = signal(false);
  nowLineLeft = signal(0);
  nowLineTop = signal(0);
  nowLineHeight = signal(0);
  nowLineLabel = signal('');
  pendingCustomerId: string | null = null;
  viewMode = signal<CalendarViewMode>('day');
  viewAnchor = signal(this.localTodayDatePart().toString());
  readonly calendarViews: Array<{ id: CalendarViewMode; label: string }> = [
    { id: 'day', label: 'Day' },
    { id: 'week', label: 'Week' },
    { id: 'month', label: 'Month' }
  ];
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
  readonly bayLegend = computed(() => this.resources().map(resource => ({
    id: String(resource.id),
    name: String(resource.name || resource.id),
    color: this.resolveBayColor(String(resource.id))
  })));
  private bayColorMap = computed(() => {
    const map: Record<string, string> = {};
    const resources = this.resources();
    for (let i = 0; i < resources.length; i++) {
      const id = String(resources[i].id || '').trim();
      if (!id) continue;
      map[id] = this.eventAccentPalette[i % this.eventAccentPalette.length];
    }
    return map;
  });
  private monthItemMap = computed(() => {
    const map: Record<string, ScheduleItem> = {};
    for (const item of this.items()) map[String(item.id)] = item;
    return map;
  });
  readonly viewRangeLabel = computed(() => {
    const mode = this.viewMode();
    const start = this.currentViewStartDate();
    if (mode === 'month') {
      return this.currentViewAnchorDate().toString('MMMM yyyy');
    }
    if (mode === 'week') {
      const dayCount = this.settingsShowWeekends() ? 7 : 5;
      const end = start.addDays(dayCount - 1);
      return `${start.toString('MMM d')} - ${end.toString('MMM d, yyyy')}`;
    }
    return start.toString('dddd, MMM d, yyyy');
  });
  readonly monthViewLabel = computed(() => this.currentViewAnchorDate().toString('MMMM yyyy'));
  readonly isMonthView = computed(() => this.viewMode() === 'month');
  readonly editorDirty = computed(() => this.editorSnapshotValue() !== this.editorInitialSnapshot());
  readonly settingsDirty = computed(() => this.settingsSnapshotValue() !== this.settingsInitialSnapshot());

  config: DayPilot.SchedulerConfig = {
    startDate: this.localTodayDatePart(),
    days: 1,
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
    width: '100%',
    headerHeight: 40,
    rowMarginTop: 10,
    rowMarginBottom: 10,
    eventHeight: 60,
    heightSpec: 'Fixed',
    height: 600,
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
      const datePart = args.cell.start.getDatePart();
      const dateKey = datePart.toString('yyyy-MM-dd');
      const isToday = dateKey === this.localTodayDatePart().toString('yyyy-MM-dd');
      const isHoliday = this.isHoliday(args.cell.start);
      const holidayLabel = this.holidayLabelForDate(dateKey);
      const cellProps = args.cell.properties as any;
      const isDark = this.isDarkTheme();
      const baseCellBg = isDark ? '#132033' : '#eef3f9';
      const holidayCellBg = isDark ? '#2b313b' : '#d8dde7';
      const todayCellBg = isDark ? '#1f2f49' : '#fef6e7';
      const cellTextColor = isDark ? '#dbeafe' : '#1e293b';
      let cellBg = baseCellBg;
      if (isHoliday) {
        cellBg = holidayCellBg;
      } else if (isToday) {
        cellBg = todayCellBg;
      }

      cellProps.backColor = cellBg;
      cellProps.fontColor = cellTextColor;
      cellProps.cssClass = isHoliday
        ? 'pf-sched-cell-holiday'
        : (isToday ? 'pf-sched-cell-today' : 'pf-sched-cell-base');

      if (isHoliday || isToday) {
        cellProps.toolTip = isHoliday && holidayLabel
          ? (isToday ? `${holidayLabel}\nToday` : holidayLabel)
          : 'Today';
      }
    },
    onBeforeEventRender: args => {
      const tags: any = args.data.tags || {};
      const start = new DayPilot.Date(args.data.start);
      const end = new DayPilot.Date(args.data.end);
      const timeLabel = `${start.toString('h:mm tt')}–${end.toString('h:mm tt')}`;
      const bayName = String(tags.bayName || this.resolveBayName(String(args.data.resource || '')) || '');
      const timeAndBayLabel = bayName ? `${timeLabel} • ${bayName}` : timeLabel;
      const isBlocked = !!tags.isBlocked;
      const serviceAccent = this.resolveBayColor(String(args.data.resource || ''));
      const accent = isBlocked ? '#94a3b8' : serviceAccent;
      const isDark = this.isDarkTheme();
      const textColor = isDark ? '#f8fbff' : '#10243c';

      args.data.html = `
        <div class="evt-content">
          <span class="evt-side-accent" style="background:${accent}"></span>
          <div class="evt-main">
            <div class="evt-title-row">
              <span class="evt-accent-dot" style="background:${accent}"></span>
              <div class="evt-title">${this.escapeHtml(String(args.data.text || ''))}</div>
            </div>
            <div class="evt-time">${this.escapeHtml(timeAndBayLabel)}</div>
          </div>
        </div>
      `;
      if (isBlocked) {
        args.data.cssClass = 'evt-blocked';
        args.data.backColor = isDark ? '#2b3443' : '#eceff4';
        args.data.borderColor = isDark ? 'rgba(148, 163, 184, 0.45)' : 'rgba(100, 116, 139, 0.4)';
        args.data.barColor = '#94a3b8';
        args.data.barBackColor = isDark ? 'rgba(148, 163, 184, 0.22)' : 'rgba(100, 116, 139, 0.18)';
        args.data.fontColor = isDark ? '#e2e8f0' : '#334155';
      } else {
        args.data.cssClass = 'evt-service';
        args.data.backColor = isDark ? this.hexToRgba(serviceAccent, 0.34) : this.hexToRgba(serviceAccent, 0.22);
        args.data.borderColor = this.hexToRgba(serviceAccent, isDark ? 0.88 : 0.62);
        args.data.barColor = serviceAccent;
        args.data.barBackColor = this.hexToRgba(serviceAccent, isDark ? 0.5 : 0.3);
        args.data.fontColor = textColor;
      }
    }
  };

  monthConfig: DayPilot.MonthConfig = {
    startDate: this.localTodayDatePart().firstDayOfMonth(),
    eventClickHandling: 'Enabled',
    eventDeleteHandling: 'Disabled',
    eventMoveHandling: 'Update',
    eventResizeHandling: 'Disabled',
    timeRangeSelectedHandling: 'Disabled',
    weekStarts: 0,
    eventHeight: 15,
    width: '100%',
    onBeforeCellRender: args => {
      const dateKey = args.cell.start.toString('yyyy-MM-dd');
      const todayDate = this.localTodayDatePart();
      const todayKey = todayDate.toString('yyyy-MM-dd');
      const day = args.cell.start.toString('d');
      const isToday = dateKey === todayKey;
      const isPast = dateKey < todayKey;
      const isHoliday = this.isHoliday(args.cell.start);
      const holidayLabel = this.holidayLabelForDate(dateKey);
      const cellProps = args.cell.properties as any;
      const isDark = this.isDarkTheme();
      const futureCellBg = isDark ? '#152338' : '#ffffff';
      const pastCellBg = isDark ? '#132033' : '#eef3f9';
      const holidayCellBg = isDark ? '#2b313b' : '#d8dde7';
      const todayCellBg = isDark ? '#1f2f49' : '#fef6e7';
      const cellBg = isHoliday ? holidayCellBg : (isToday ? todayCellBg : (isPast ? pastCellBg : futureCellBg));
      const classes = ['pf-month-cell'];
      if (isHoliday) classes.push('pf-month-cell-holiday');
      if (isToday) classes.push('pf-month-cell-today');
      if (!isHoliday && !isToday) classes.push(isPast ? 'pf-month-cell-past' : 'pf-month-cell-future');
      cellProps.cssClass = classes.join(' ');

      cellProps.backColor = cellBg;

      const dayColor = isDark ? '#dbeafe' : '#1e293b';
      const metaColor = isDark ? 'rgba(191, 219, 254, 0.8)' : 'rgba(30, 41, 59, 0.72)';

      cellProps.fontColor = dayColor;
      cellProps.headerFontColor = dayColor;
      cellProps.headerBackColor = 'transparent';
      const dayWeight = isToday ? 800 : 700;
      const dayHtml = `<span style="font-weight:${dayWeight};color:${dayColor}">${day}</span>`;
      const holidayHtml = holidayLabel
        ? `<div style="margin-top:1px;font-size:8px;line-height:1.1;color:${metaColor};max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${this.escapeHtml(holidayLabel)}</div>`
        : '';
      cellProps.headerHtml = `<div style="display:flex;flex-direction:column;align-items:flex-start">${dayHtml}${holidayHtml}</div>`;
      if (holidayLabel) cellProps.toolTip = holidayLabel;
    },
    onBeforeEventRender: args => {
      const data = args.data as any;
      const item = this.monthItemMap()[String(data.id)] || null;
      const resourceId = String(item?.resource || data.resource || '');
      const isBlocked = Boolean(item?.isBlocked || data.tags?.isBlocked);
      const color = isBlocked ? '#94a3b8' : this.resolveBayColor(resourceId);
      const bayName = this.resolveBayName(resourceId);
      const label = String(data.text || '').trim() || 'Appointment';
      const monthLabel = bayName ? `${label} • ${bayName}` : label;
      const isDark = this.isDarkTheme();
      const monthTextColor = isBlocked ? (isDark ? '#e2e8f0' : '#334155') : (isDark ? '#f8fbff' : '#10243c');
      args.data.barColor = color;
      args.data.barBackColor = this.hexToRgba(color, 0.3);
      args.data.borderColor = this.hexToRgba(color, isDark ? 0.88 : 0.62);
      args.data.backColor = isBlocked
        ? (isDark ? '#334155' : '#e2e8f0')
        : this.hexToRgba(color, isDark ? 0.34 : 0.22);
      args.data.fontColor = monthTextColor;
      args.data.toolTip = `${label}${bayName ? `\nLift/Bay: ${bayName}` : ''}`;
      args.data.html = `
        <div class="pf-month-event" style="cursor:grab">
          <span class="pf-month-event-dot" style="background:${color}"></span>
          <span class="pf-month-event-text" style="color:${monthTextColor}">${this.escapeHtml(monthLabel)}</span>
        </div>
      `;
    },
    onEventClick: args => {
      this.openEditorById(String(args.e.data.id));
    },
    onEventMoved: args => {
      const eventId = String(args.e.data.id || '');
      if (!eventId) return;
      const current = this.monthItemMap()[eventId];
      const resource = String(current?.resource || args.e.data.resource || this.resources()[0]?.id || '');
      this.updateEventTime(eventId, args.newStart, args.newEnd, resource);
    }
  };

  constructor(
    private customersApi: CustomersApi,
    private scheduleApi: ScheduleApi,
    private settingsApi: AppSettingsApiService,
    private userSettings: UserScopedSettingsService,
    private route: ActivatedRoute
  ) {
    addIcons({
      'settings-outline': settingsOutline,
      'add-outline': addOutline,
      'trash-outline': trashOutline
    });
    this.applySettings(this.defaultSettings());
    this.loadPersistedSettings();
    this.loadPersistedCalendarView();
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
    this.applyViewConfig(false);
    this.updateSchedulerHeight();
    this.startNowLineTimer();
    if (this.scheduleShell?.nativeElement) {
      this.resizeObserver = new ResizeObserver(() => {
        this.applyViewConfig(false);
        this.updateSchedulerHeight();
      });
      this.resizeObserver.observe(this.scheduleShell.nativeElement);
    }
  }

  ngOnDestroy() {
    if (this.resizeObserver && this.scheduleShell?.nativeElement) {
      this.resizeObserver.unobserve(this.scheduleShell.nativeElement);
      this.resizeObserver.disconnect();
    }
    this.resizeObserver = null;
    this.clearStatusTimer();
    this.stopNowLineTimer();
    this.clearNowLineScrollListener();
  }

  private resizeObserver: ResizeObserver | null = null;

  private updateSchedulerHeight() {
    if (this.viewMode() === 'month') {
      this.hideNowLine();
      return;
    }
    const shell = this.scheduleShell?.nativeElement;
    if (!shell) {
      this.hideNowLine();
      return;
    }
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
    this.syncNowLine();
  }

  private updateMonthViewportHeight(monthStart?: DayPilot.Date): void {
    if (this.viewMode() !== 'month') return;
    const shell = this.scheduleShell?.nativeElement;
    const monthShell = shell?.querySelector<HTMLElement>('.month-shell');
    if (!monthShell) return;

    const anchor = (monthStart ? monthStart.getDatePart() : this.currentViewAnchorDate()).firstDayOfMonth();
    const weekCount = this.resolveMonthWeekCount(anchor);
    const effectiveRows = Math.max(5, weekCount);
    const headerHeight = this.monthConfig.headerHeight ?? 32;
    const shellHeight = Math.max(320, monthShell.clientHeight);
    const usable = Math.max(240, shellHeight - headerHeight - 2);
    const calculatedHeight = Math.floor(usable / effectiveRows);
    const cellHeight = Math.min(this.monthMaxCellHeight, Math.max(this.monthMinCellHeight, calculatedHeight));

    this.monthConfig.startDate = anchor;
    this.monthConfig.cellHeight = cellHeight;
    if (this.month?.control) {
      this.month.control.update({
        startDate: anchor,
        cellHeight,
        width: '100%'
      });
    }
  }

  private scheduleMonthViewportHeightUpdate(monthStart?: DayPilot.Date): void {
    const target = (monthStart ? monthStart.getDatePart() : this.currentViewAnchorDate()).firstDayOfMonth();
    this.updateMonthViewportHeight(target);
    requestAnimationFrame(() => this.updateMonthViewportHeight(target));
  }

  private resolveMonthWeekCount(monthStart: DayPilot.Date): number {
    const anchor = monthStart.firstDayOfMonth();
    const asDate = new Date(`${anchor.toString('yyyy-MM-dd')}T00:00:00`);
    const year = asDate.getFullYear();
    const monthIndex = asDate.getMonth();
    const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
    const weekStarts = typeof this.monthConfig.weekStarts === 'number' ? this.monthConfig.weekStarts : 0;
    const monthFirstDay = new Date(year, monthIndex, 1);
    const startOffset = (7 + monthFirstDay.getDay() - weekStarts) % 7;
    const totalCells = startOffset + daysInMonth;
    return Math.max(4, Math.ceil(totalCells / 7));
  }

  setCalendarView(mode: CalendarViewMode): void {
    if (this.viewMode() === mode) return;
    const anchor = this.currentViewAnchorDate();
    this.viewMode.set(mode);
    this.persistCalendarView();
    this.applyViewConfig(true, anchor);
  }

  previousCalendarRange(): void {
    const mode = this.viewMode();
    const anchor = this.currentViewAnchorDate();
    const next = mode === 'month'
      ? anchor.addMonths(-1)
      : (mode === 'week' ? anchor.addDays(-7) : anchor.addDays(-1));
    this.viewAnchor.set(next.getDatePart().toString());
    this.persistCalendarViewAnchor();
    this.applyViewConfig(true, next);
  }

  nextCalendarRange(): void {
    const mode = this.viewMode();
    const anchor = this.currentViewAnchorDate();
    const next = mode === 'month'
      ? anchor.addMonths(1)
      : (mode === 'week' ? anchor.addDays(7) : anchor.addDays(1));
    this.viewAnchor.set(next.getDatePart().toString());
    this.persistCalendarViewAnchor();
    this.applyViewConfig(true, next);
  }

  jumpToToday(): void {
    const today = this.localTodayDatePart();
    const currentMode = this.viewMode();
    if (currentMode === 'week' && !this.settingsShowWeekends() && this.isWeekendDay(today)) {
      this.viewMode.set('day');
      this.setStatusSuccess('Week view hides weekends. Switched to Day view for today.');
    }
    this.viewAnchor.set(today.toString());
    this.persistCalendarView();
    this.applyViewConfig(true, today);
  }

  isCalendarView(mode: CalendarViewMode): boolean {
    return this.viewMode() === mode;
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

  private loadPersistedCalendarView(): void {
    this.userSettings.getValue<CalendarViewMode>(SCHEDULE_VIEW_MODE_KEY).subscribe(value => {
      if (value === 'day' || value === 'week' || value === 'month') {
        this.viewMode.set(value);
      }
      this.applyViewConfig(false);
    });
    this.userSettings.getValue<string>(SCHEDULE_VIEW_ANCHOR_KEY).subscribe(value => {
      if (value) {
        const parsed = new DayPilot.Date(value);
        this.viewAnchor.set(parsed.getDatePart().toString());
      }
      this.applyViewConfig(false);
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
    this.applyViewConfig(false);

    if (this.scheduler?.control) {
      this.scheduler.control.update({
        resources,
        businessBeginsHour: s.openHour,
        businessEndsHour: s.closeHour,
        businessWeekends: s.showWeekends
      });
    }
    this.updateSchedulerHeight();
  }

  private applyViewConfig(ensureVisible: boolean, anchorDate?: DayPilot.Date): void {
    const mode = this.viewMode();
    const anchor = (anchorDate ? anchorDate.getDatePart() : this.currentViewAnchorDate());
    this.viewAnchor.set(anchor.toString());
    const start = this.alignStartForMode(anchor, mode);

    if (mode === 'month') {
      const monthStart = anchor.firstDayOfMonth();
      this.monthConfig.startDate = monthStart;
      this.scheduleMonthViewportHeightUpdate(monthStart);
      this.hideNowLine();
      return;
    }

    const showWeekends = this.settingsShowWeekends();
    const days = mode === 'week' ? (showWeekends ? 7 : 5) : 1;
    const scale: DayPilot.SchedulerConfig['scale'] = mode === 'week' ? 'Day' : 'Hour';
    const timeHeaders: DayPilot.SchedulerConfig['timeHeaders'] = mode === 'week'
      ? [
          { groupBy: 'Week', format: 'MMMM d' },
          { groupBy: 'Day', format: 'ddd d' }
        ]
      : [
          { groupBy: 'Day', format: 'dddd, MMM d' },
          { groupBy: 'Hour', format: 'h tt' }
        ];
    const cellDuration = mode === 'day' ? 30 : 1440;
    const cellWidth = this.resolveCellWidth(mode, days);
    this.config.startDate = start;
    this.config.days = days;
    this.config.scale = scale;
    this.config.timeHeaders = timeHeaders;
    this.config.cellDuration = cellDuration;
    this.config.cellWidth = cellWidth;

    if (this.scheduler?.control) {
      this.scheduler.control.update({
        startDate: start,
        days,
        scale,
        timeHeaders,
        cellDuration,
        cellWidth,
        width: '100%'
      });
      if (ensureVisible) {
        const anchor = this.resolveVisibleAnchor(start, days, mode, anchorDate);
        this.scrollToAnchor(anchor, mode);
      }
    }
    this.updateSchedulerHeight();
  }

  private startNowLineTimer(): void {
    this.stopNowLineTimer();
    this.syncNowLine();
    this.nowLineTimer = setInterval(() => this.syncNowLine(), 30_000);
  }

  private stopNowLineTimer(): void {
    if (this.nowLineTimer) {
      clearInterval(this.nowLineTimer);
      this.nowLineTimer = null;
    }
  }

  private clearNowLineScrollListener(): void {
    if (this.nowLineScrollEl) {
      this.nowLineScrollEl.removeEventListener('scroll', this.onNowLineScroll);
      this.nowLineScrollEl = null;
    }
  }

  private bindNowLineScrollListener(element: HTMLElement): void {
    if (this.nowLineScrollEl === element) return;
    this.clearNowLineScrollListener();
    this.nowLineScrollEl = element;
    this.nowLineScrollEl.addEventListener('scroll', this.onNowLineScroll, { passive: true });
  }

  private hideNowLine(): void {
    this.showNowLine.set(false);
    this.clearNowLineScrollListener();
  }

  private syncNowLine(): void {
    if (this.viewMode() !== 'day') {
      this.hideNowLine();
      return;
    }

    const control = this.scheduler?.control as any;
    const shell = this.scheduleShell?.nativeElement;
    if (!control || !shell || typeof control.visibleStart !== 'function' || typeof control.visibleEnd !== 'function' || typeof control.getPixels !== 'function') {
      this.hideNowLine();
      return;
    }

    const scrollable = shell.querySelector<HTMLElement>('.scheduler_default_scrollable');
    const matrix = shell.querySelector<HTMLElement>('.scheduler_default_matrix');
    if (!scrollable || !matrix) {
      this.hideNowLine();
      return;
    }

    this.bindNowLineScrollListener(scrollable);

    const now = new DayPilot.Date(formatLocalDateTime(new Date()));
    const visibleStart = control.visibleStart();
    const visibleEnd = control.visibleEnd();
    if (!visibleStart || !visibleEnd) {
      this.hideNowLine();
      return;
    }

    const nowTicks = now.getTime();
    const startTicks = visibleStart.getTime();
    const endTicks = visibleEnd.getTime();
    if (nowTicks < startTicks || nowTicks > endTicks) {
      this.hideNowLine();
      return;
    }

    const pixels = control.getPixels(now);
    if (!pixels || typeof pixels.left !== 'number' || !Number.isFinite(pixels.left)) {
      this.hideNowLine();
      return;
    }

    const shellRect = shell.getBoundingClientRect();
    const matrixRect = matrix.getBoundingClientRect();
    const scrollRect = scrollable.getBoundingClientRect();
    const left = Math.round(matrixRect.left - shellRect.left + pixels.left);
    const minLeft = Math.round(scrollRect.left - shellRect.left);
    const maxLeft = Math.round(scrollRect.right - shellRect.left);

    if (!Number.isFinite(left) || left < minLeft - 2 || left > maxLeft + 2) {
      this.hideNowLine();
      return;
    }

    this.nowLineLeft.set(left);
    this.nowLineTop.set(Math.round(scrollRect.top - shellRect.top));
    this.nowLineHeight.set(Math.max(0, Math.round(scrollRect.height)));
    this.nowLineLabel.set(this.formatNowLineLabel());
    this.showNowLine.set(true);
  }

  private formatNowLineLabel(): string {
    const now = new Date();
    return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  private currentViewAnchorDate(): DayPilot.Date {
    return new DayPilot.Date(this.viewAnchor()).getDatePart();
  }

  private currentViewStartDate(): DayPilot.Date {
    return this.alignStartForMode(this.currentViewAnchorDate(), this.viewMode());
  }

  private alignStartForMode(start: DayPilot.Date, mode: CalendarViewMode): DayPilot.Date {
    const date = start.getDatePart();
    if (mode === 'month') {
      return date.firstDayOfMonth();
    }
    if (mode === 'week') {
      return date.firstDayOfWeek(this.settingsShowWeekends() ? 0 : 1);
    }
    return date;
  }

  private resolveCellWidth(mode: CalendarViewMode, days: number): number {
    if (mode === 'day') return this.dayCellWidth;
    if (mode !== 'week') return this.weekMinCellWidth;
    const shellWidth = this.scheduleShell?.nativeElement?.clientWidth || 0;
    const rowHeaderWidth = this.config.rowHeaderWidth ?? 110;
    const chrome = 34;
    const available = Math.max(0, shellWidth - rowHeaderWidth - chrome);
    if (!available || !days) {
      return this.weekMinCellWidth;
    }
    return Math.max(this.weekMinCellWidth, Math.floor(available / days));
  }

  private isWeekendDay(date: DayPilot.Date): boolean {
    const day = date.dayOfWeek();
    return day === 0 || day === 6;
  }

  private localTodayDatePart(): DayPilot.Date {
    const now = new Date();
    return DayPilot.Date.fromYearMonthDay(now.getFullYear(), now.getMonth() + 1, now.getDate()).getDatePart();
  }

  private resolveVisibleAnchor(start: DayPilot.Date, days: number, mode: CalendarViewMode, preferred?: DayPilot.Date): DayPilot.Date {
    if (mode === 'day') {
      return start.addHours(this.settingsOpenHour());
    }
    const preferredDate = preferred?.getDatePart() || null;
    if (preferredDate) {
      const preferredTick = preferredDate.getTime();
      const rangeStartTick = start.getTime();
      const rangeEndTick = start.addDays(days).getTime();
      if (preferredTick >= rangeStartTick && preferredTick < rangeEndTick) {
        return preferredDate;
      }
    }
    const today = this.localTodayDatePart();
    const todayTick = today.getTime();
    const rangeStartTick = start.getTime();
    const rangeEndTick = start.addDays(days).getTime();
    return (todayTick >= rangeStartTick && todayTick < rangeEndTick) ? today : start;
  }

  private scrollToAnchor(anchor: DayPilot.Date, mode: CalendarViewMode): void {
    const control = this.scheduler?.control;
    if (!control) return;
    const anchorTarget = mode === 'day' ? anchor : anchor.getDatePart();
    const schedule = () => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const c = this.scheduler?.control;
          if (!c) return;
          c.scrollTo(anchorTarget);
        });
      });
    };
    schedule();
    setTimeout(schedule, 35);
  }

  private persistCalendarView(): void {
    this.persistCalendarViewMode();
    this.persistCalendarViewAnchor();
  }

  private persistCalendarViewMode(): void {
    this.userSettings.setValue(SCHEDULE_VIEW_MODE_KEY, this.viewMode()).subscribe({ error: () => {} });
  }

  private persistCalendarViewAnchor(): void {
    this.userSettings.setValue(SCHEDULE_VIEW_ANCHOR_KEY, this.viewAnchor()).subscribe({ error: () => {} });
  }

  private loadAll() {
    this.clearStatus();
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
          error: () => {
            this.setStatusError('Could not load schedule.');
            this.loading.set(false);
          }
        });
      },
      error: () => {
        this.setStatusError('Could not load customers.');
        this.loading.set(false);
      }
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
          bayName: this.resolveBayName(String(it.resource || '')),
          vehicleColor: cust?.vehicleColor || ''
        }
      });
    }
    this.events.set(list);
    this.monthEvents.set(list);
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
    this.editorError.set('');
    this.markEditorPristine();
    this.editorOpen.set(true);
  }

  closeEditor() {
    this.editorOpen.set(false);
    this.editorError.set('');
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
    const partRequests = isBlocked ? [] : this.parsePartRequestsFromEditor(this.editorParts());
    const repeatEvery = Math.max(0, Number(this.editorRepeatEvery()) || 0);
    const repeatCount = Math.max(1, Number(this.editorRepeatCount()) || 1);

    const base = { start, end, resource, customerId, isBlocked, title, notes, partRequests };
    const id = this.editorId();

    if (id) {
      this.scheduleApi.update({ id, ...base }).subscribe({
        next: () => {
          this.loadAll();
          this.editorOpen.set(false);
          this.setStatusSuccess('Appointment saved.');
        },
        error: () => {
          this.editorError.set('Could not save appointment. Try again.');
          this.setStatusError('Could not save appointment.');
        }
      });
      return;
    }

    const createOne = (s: string, e: string) =>
      this.scheduleApi.create({ ...base, start: s, end: e }).subscribe({
        next: () => { this.loadAll(); },
        error: () => {
          this.editorError.set('Could not save appointment. Try again.');
          this.setStatusError('Could not save appointment.');
        }
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
    this.setStatusSuccess('Appointment saved.');
  }

  deleteEditor() {
    const id = this.editorId();
    if (!id) { this.editorOpen.set(false); return; }
    if (!window.confirm('Delete this appointment?')) return;
    this.scheduleApi.delete(id).subscribe({
      next: () => {
        this.loadAll();
        this.editorOpen.set(false);
        this.setStatusSuccess('Appointment deleted.');
      },
      error: () => this.setStatusError('Could not delete appointment.')
    });
  }

  private updateEventTime(id: string, start: DayPilot.Date, end: DayPilot.Date, resource: string) {
    this.scheduleApi.update({ id, start: start.toString(), end: end.toString(), resource: String(resource) }).subscribe({
      next: () => { this.loadAll(); },
      error: () => this.setStatusError('Could not update appointment.')
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
    this.settingsError.set('');
    this.markSettingsPristine();
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
    const validationMessage = this.settingsValidationError();
    if (validationMessage) {
      this.settingsError.set(validationMessage);
      this.setStatusError(validationMessage);
      return;
    }

    this.settingsError.set('');
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
    this.setStatusSuccess('Schedule settings saved.');
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

  private holidayLabelForDate(dateKey: string): string {
    const federal = this.federalHolidayList().find(h => h.date === dateKey);
    if (federal?.name) return federal.name;
    return this.settingsHolidays().includes(dateKey) ? 'Holiday' : '';
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

  settingsValidationError(): string {
    if (!this.settingsBays().length) {
      return 'At least one bay is required.';
    }
    if (this.settingsBays().some(bay => !(bay.name || '').trim())) {
      return 'Each bay must have a name.';
    }
    if (this.settingsCloseHour() <= this.settingsOpenHour()) {
      return 'Close time must be after open time.';
    }
    return '';
  }

  canSaveSettings(): boolean {
    return !this.settingsValidationError() && this.settingsDirty();
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
      notes: this.editorNotes().trim(),
      parts: this.editorParts().trim(),
      repeatEvery: Math.max(0, Number(this.editorRepeatEvery()) || 0),
      repeatCount: Math.max(1, Number(this.editorRepeatCount()) || 1)
    });
  }

  private settingsSnapshotValue(): string {
    return JSON.stringify({
      bays: this.settingsBays().map(b => ({
        id: String(b.id || '').trim(),
        name: String(b.name || '').trim()
      })),
      openHour: Math.min(23, Math.max(0, Number(this.settingsOpenHour()) || 0)),
      closeHour: Math.min(24, Math.max(1, Number(this.settingsCloseHour()) || 1)),
      showWeekends: !!this.settingsShowWeekends(),
      holidays: [...this.settingsHolidays()].sort(),
      federalYear: Math.max(1900, Math.min(2100, Number(this.settingsFederalYear()) || new Date().getFullYear()))
    });
  }

  private markEditorPristine(): void {
    this.editorInitialSnapshot.set(this.editorSnapshotValue());
  }

  private markSettingsPristine(): void {
    this.settingsInitialSnapshot.set(this.settingsSnapshotValue());
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

  private resolveBayColor(resourceId: string): string {
    const id = String(resourceId || '').trim();
    if (!id) return this.eventAccentPalette[0];
    const mapped = this.bayColorMap()[id];
    if (mapped) return mapped;
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 33 + id.charCodeAt(i)) >>> 0;
    }
    return this.eventAccentPalette[hash % this.eventAccentPalette.length];
  }

  private resolveBayName(resourceId: string): string {
    const id = String(resourceId || '').trim();
    if (!id) return '';
    const resource = this.resources().find(r => String(r.id || '').trim() === id);
    return resource ? String(resource.name || id) : '';
  }

  private openEditorById(id: string): void {
    const item = this.items().find(entry => String(entry.id) === String(id));
    if (!item) return;
    this.openEditor({
      id: String(item.id),
      start: item.start,
      end: item.end,
      resource: String(item.resource || ''),
      customerId: item.customerId || '',
      isBlocked: !!item.isBlocked,
      title: item.title || '',
      notes: item.notes || '',
      partRequests: Array.isArray(item.partRequests) ? item.partRequests : []
    });
  }

  private resolveEventAccentColor(vehicleColor: string, customerId: string, resourceId: string): string {
    const key = `${customerId || ''}|${resourceId || ''}`;
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    const fallback = this.eventAccentPalette[hash % this.eventAccentPalette.length];
    const explicit = this.normalizeHexColor(vehicleColor);
    if (explicit) {
      const l = this.relativeLuminance(explicit);
      if (l < 0.95 && l > 0.05) {
        return explicit;
      }
    }
    return fallback;
  }

  private normalizeHexColor(input: string): string | null {
    const value = String(input || '').trim();
    if (!value) return null;
    const short = /^#([0-9a-fA-F]{3})$/;
    const full = /^#([0-9a-fA-F]{6})$/;
    if (short.test(value)) {
      const hex = value.slice(1);
      return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toLowerCase();
    }
    if (full.test(value)) {
      return value.toLowerCase();
    }
    return null;
  }

  private hexToRgba(hex: string, alpha: number): string {
    const safe = this.normalizeHexColor(hex) || '#3b82f6';
    const normalizedAlpha = Math.max(0, Math.min(1, alpha));
    const n = Number.parseInt(safe.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${normalizedAlpha})`;
  }

  private relativeLuminance(hex: string): number {
    const safe = this.normalizeHexColor(hex) || '#3b82f6';
    const n = Number.parseInt(safe.slice(1), 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    const linear = [r, g, b].map(v => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
  }

  private readableTextOnColor(hex: string): string {
    const bgLum = this.relativeLuminance(hex);
    const darkLum = this.relativeLuminance('#0f172a');
    const lightLum = this.relativeLuminance('#f8fafc');
    const darkContrast = this.contrastRatio(bgLum, darkLum);
    const lightContrast = this.contrastRatio(bgLum, lightLum);
    return darkContrast >= lightContrast ? '#0f172a' : '#f8fafc';
  }

  private contrastRatio(a: number, b: number): number {
    const l1 = Math.max(a, b);
    const l2 = Math.min(a, b);
    return (l1 + 0.05) / (l2 + 0.05);
  }

  private isDarkTheme(): boolean {
    if (typeof document === 'undefined') return true;
    return document.documentElement.getAttribute('data-theme') !== 'light';
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
