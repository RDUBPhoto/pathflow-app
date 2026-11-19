import { UiModal } from '../../ui/overlays';
import { UiCheckbox, UiInput, UiTextarea } from '../../ui/controls';
import { Component, ViewChild, signal, computed, AfterViewInit, OnDestroy, ElementRef, ChangeDetectionStrategy } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { DayPilot, DayPilotModule, DayPilotMonthComponent, DayPilotSchedulerComponent } from '@daypilot/daypilot-lite-angular';
import { CustomersApi, Customer } from '../../services/customers-api.service';
import { ScheduleApi, ScheduleItem } from '../../services/schedule-api.service';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { PageBackButtonComponent } from '../../components/navigation/page-back-button/page-back-button.component';
import { AppSettingsApiService } from '../../services/app-settings-api.service';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { toLocalDateTimeInput, toLocalDateTimeStorage } from '../../utils/datetime-local';
import {
  DEFAULT_SHOP_TIME_ZONE, formatShopAppointment, normalizeShopTimeZone, SCHEDULE_SETTINGS_KEY,
  shopCalendarIso, shopTimeMillis, shopWallTime
} from '../../utils/shop-time';
import { UserScopedSettingsService } from '../../services/user-scoped-settings.service';
import { InvoicesDataService, InvoiceDetail } from '../../services/invoices-data.service';
import { CustomerPortalApi } from '../../services/customer-portal-api.service';
import { SmsApiService } from '../../services/sms-api.service';
import { EmailApiService } from '../../services/email-api.service';
import { BusinessProfileService } from '../../services/business-profile.service';
import { firstValueFrom } from 'rxjs';

type UICustomer = Customer & {
  vehicleYear?: string;
  vehicleMake?: string;
  vehicleModel?: string;
  vehicleColor?: string;
};

type Bay = { id: string; name: string };
type SuggestedSlot = {
  start: string;
  end: string;
  resource: string;
  label: string;
  segments?: Array<{ start: string; end: string }>;
};
type CalendarViewMode = 'day' | 'week' | 'month';
type PartRequest = { partName: string; qty: number; vendorHint?: string; sku?: string; note?: string };
type ScheduleSettings = {
  bays: Bay[];
  openHour: number;
  closeHour: number;
  timeZone?: string;
  showWeekends: boolean;
  holidays: string[];
  federalYear: number;
  federalInitialized: boolean;
};
const SCHEDULE_VIEW_MODE_KEY = 'schedule.viewMode';

@Component({
  selector: 'app-schedule',
  standalone: true,
  imports: [
    FormsModule,
    DayPilotModule,
    UiModal,
    UiInput,
    UiTextarea,
    UiCheckbox,
    UserMenuComponent,
    PageBackButtonComponent,
    CompanySwitcherComponent
],
  templateUrl: './schedule.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
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
  private readonly statusAutoDismissMs = 5000;
  private statusDismissTimer: ReturnType<typeof setTimeout> | null = null;
  private nowLineTimer: ReturnType<typeof setInterval> | null = null;
  private nowLineScrollEl: HTMLElement | null = null;
  private readonly onNowLineScroll = () => this.syncNowLine();

  @ViewChild('scheduler') scheduler?: DayPilotSchedulerComponent;
  @ViewChild('month') month?: DayPilotMonthComponent;
  @ViewChild('scheduleContent', { read: ElementRef }) scheduleContent?: ElementRef<HTMLElement>;
  @ViewChild('scheduleControls', { read: ElementRef }) scheduleControls?: ElementRef<HTMLElement>;
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
  editorPartsSourceHint = signal('');
  editorRepeatEvery = signal(0);
  editorRepeatCount = signal(1);
  editorError = signal('');
  private editorInitialSnapshot = signal('');
  appointmentInfoModalOpen = signal(false);
  appointmentInfoSchedule = signal<ScheduleItem | null>(null);
  appointmentInfoSendEmail = signal(true);
  appointmentInfoSendSms = signal(true);
  appointmentInfoMessage = signal('');
  appointmentInfoSending = signal(false);
  appointmentInfoError = signal('');

  settingsOpen = signal(false);
  settingsBays = signal<Bay[]>([]);
  settingsOpenHour = signal(7);
  settingsCloseHour = signal(16);
  settingsShowWeekends = signal(false);
  settingsHolidays = signal<string[]>([]);
  readonly shopTimeZone = signal(DEFAULT_SHOP_TIME_ZONE);
  private settingsLoaded = false;
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
  planningCustomerId = signal<string | null>(null);
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
    const anchor = this.currentViewAnchorDate();
    if (mode === 'month') {
      return anchor.toString('MMMM yyyy');
    }
    if (mode === 'week') {
      const start = this.alignStartForMode(anchor, mode);
      const end = start.addDays(this.weekDayCount(anchor) - 1);
      return `${start.toString('MMM d')} - ${end.toString('MMM d, yyyy')}`;
    }
    return anchor.toString('dddd, MMM d, yyyy');
  });
  readonly monthViewLabel = computed(() => this.currentViewAnchorDate().toString('MMMM yyyy'));
  readonly isMonthView = computed(() => this.viewMode() === 'month');
  readonly planningCustomerName = computed(() => {
    const customerId = this.planningCustomerId();
    if (!customerId) return '';
    return this.customersById()[customerId]?.name || 'Selected customer';
  });
  readonly editorPartRequests = computed(() => this.parsePartRequestsFromEditor(this.editorParts()));
  readonly suggestedSlots = computed(() => this.buildSuggestedSlots(this.planningCustomerId(), 3));
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
    eventHeight: 80,
    heightSpec: 'Fixed',
    height: 500,
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
      const planningCustomerId = this.planningCustomerId();
      this.openEditor({
        id: null,
        start: start.toString(),
        end: finalEnd.toString(),
        resource: String(args.resource),
        customerId: planningCustomerId || undefined
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
      const isCompleted = !!tags.completed;
      const completedAtLabel = String(tags.completedAtLabel || '').trim();
      const serviceAccent = this.resolveBayColor(String(args.data.resource || ''));
      const accent = isBlocked ? '#94a3b8' : (isCompleted ? '#22c55e' : serviceAccent);
      const isDark = this.isDarkTheme();
      const textColor = isDark ? '#f8fbff' : '#10243c';
      const metaLine = isCompleted
        ? `Completed${completedAtLabel ? ` • ${completedAtLabel}` : ''}`
        : timeAndBayLabel;

      args.data.html = `
        <div class="evt-content">
          <span class="evt-side-accent" style="background:${accent}"></span>
          <div class="evt-main">
            <div class="evt-title-row">
              <span class="evt-accent-dot" style="background:${accent}"></span>
              <div class="evt-title">${this.escapeHtml(String(args.data.text || ''))}</div>
            </div>
            <div class="evt-time">${this.escapeHtml(metaLine)}</div>
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
      } else if (isCompleted) {
        args.data.cssClass = 'evt-service';
        args.data.backColor = isDark ? 'rgba(34, 197, 94, 0.28)' : 'rgba(34, 197, 94, 0.2)';
        args.data.borderColor = isDark ? 'rgba(74, 222, 128, 0.75)' : 'rgba(34, 197, 94, 0.6)';
        args.data.barColor = '#22c55e';
        args.data.barBackColor = isDark ? 'rgba(74, 222, 128, 0.42)' : 'rgba(34, 197, 94, 0.32)';
        args.data.fontColor = textColor;
      } else {
        args.data.cssClass = 'evt-service';
        args.data.backColor = isDark ? this.hexToRgba(serviceAccent, 0.9) : this.hexToRgba(serviceAccent, 0.22);
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
    headerHeight: 30,
    cellHeight: this.monthMinCellHeight,
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
      const currentDate = isToday ? ' aria-current="date"' : '';
      const dayHtml = `<span${currentDate} style="font-weight:${dayWeight};color:${dayColor}">${day}</span>`;
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
      const isCompleted = Boolean(data.tags?.completed);
      const color = isBlocked ? '#94a3b8' : (isCompleted ? '#22c55e' : this.resolveBayColor(resourceId));
      const bayName = this.resolveBayName(resourceId);
      const label = String(data.text || '').trim() || 'Appointment';
      const completedAtLabel = String(data.tags?.completedAtLabel || '').trim();
      const monthLabelBase = bayName ? `${label} • ${bayName}` : label;
      const monthLabel = isCompleted
        ? `${monthLabelBase} (Completed${completedAtLabel ? ` ${completedAtLabel}` : ''})`
        : monthLabelBase;
      const isDark = this.isDarkTheme();
      const monthTextColor = isBlocked
        ? (isDark ? '#e2e8f0' : '#334155')
        : (isCompleted ? (isDark ? '#dcfce7' : '#14532d') : (isDark ? '#f8fbff' : '#10243c'));
      args.data.barColor = color;
      args.data.barBackColor = this.hexToRgba(color, 0.3);
      args.data.borderColor = this.hexToRgba(color, isDark ? 0.88 : 0.62);
      args.data.backColor = isBlocked
        ? (isDark ? '#334155' : '#e2e8f0')
        : this.hexToRgba(color, isDark ? (isCompleted ? 0.36 : 0.46) : (isCompleted ? 0.24 : 0.28));
      args.data.fontColor = monthTextColor;
      args.data.toolTip = `${label}${bayName ? `\nLift/Bay: ${bayName}` : ''}`;
      args.data.html = `
        <div class="pf-month-event" style="cursor:grab">
          <span class="pf-month-event-dot" style="background:${color}"></span>
          <span class="pf-month-event-text" style="color:${monthTextColor} !important">${this.escapeHtml(monthLabel)}</span>
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
    private invoicesData: InvoicesDataService,
    private smsApi: SmsApiService,
    private emailApi: EmailApiService,
    private businessProfile: BusinessProfileService,
    private customerPortal: CustomerPortalApi,
    private route: ActivatedRoute
  ) {
    this.loadPersistedSettings();
    this.route.queryParamMap.subscribe(params => {
      const id = params.get('customerId');
      const autoOpenRaw = (params.get('autoOpen') || '').trim().toLowerCase();
      const shouldAutoOpen = autoOpenRaw !== '0' && autoOpenRaw !== 'false' && autoOpenRaw !== 'no';
      if (id) {
        this.planningCustomerId.set(id);
        this.pendingCustomerId = shouldAutoOpen ? id : null;
        if (shouldAutoOpen) {
          this.tryOpenFromQuery();
        }
      } else {
        this.planningCustomerId.set(null);
        this.pendingCustomerId = null;
      }
    });
  }

  ngAfterViewInit() {
    this.applyViewConfig(false);
    this.startNowLineTimer();
    this.resizeObserver = new ResizeObserver(() => {
      if (this.isMonthView()) this.scheduleMonthViewportHeightUpdate();
      else this.applyViewConfig(false);
    });
    for (const element of [this.scheduleContent, this.scheduleControls, this.scheduleShell]) {
      if (element) this.resizeObserver.observe(element.nativeElement);
    }
  }

  ngOnDestroy() {
    this.resizeObserver?.disconnect();
    if (this.monthViewportFrame !== null) cancelAnimationFrame(this.monthViewportFrame);
    this.clearStatusTimer();
    this.stopNowLineTimer();
    this.clearNowLineScrollListener();
  }

  private resizeObserver: ResizeObserver | null = null;
  private monthViewportFrame: number | null = null;

  private updateMonthViewportHeight(): void {
    if (!this.isMonthView()) return;
    const content = this.scheduleContent?.nativeElement;
    const shell = this.scheduleShell?.nativeElement;
    const monthShell = shell?.querySelector<HTMLElement>('.month-shell');
    if (!content || !shell || !monthShell) return;

    const monthTop = monthShell.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop;
    const shellStyle = getComputedStyle(shell);
    const monthStyle = getComputedStyle(monthShell);
    const insets = parseFloat(getComputedStyle(content).paddingBottom) + parseFloat(shellStyle.paddingBottom)
      + parseFloat(shellStyle.borderBottomWidth) + parseFloat(monthStyle.borderTopWidth)
      + parseFloat(monthStyle.borderBottomWidth);
    const available = content.clientHeight - monthTop - insets - (this.monthConfig.headerHeight ?? 30);
    const weekCount = this.resolveMonthWeekCount(this.currentViewAnchorDate());
    const cellHeight = Math.max(this.monthMinCellHeight, Math.floor(available / weekCount));
    if (this.monthConfig.cellHeight === cellHeight) return;
    this.monthConfig.cellHeight = cellHeight;
    this.month?.control.update({ cellHeight });
  }

  private scheduleMonthViewportHeightUpdate(): void {
    if (this.monthViewportFrame !== null) return;
    this.monthViewportFrame = requestAnimationFrame(() => {
      this.monthViewportFrame = null;
      this.updateMonthViewportHeight();
    });
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
    this.persistCalendarViewMode();
    this.applyViewConfig(true, anchor);
  }

  previousCalendarRange(): void {
    const mode = this.viewMode();
    const anchor = this.currentViewAnchorDate();
    const next = mode === 'month'
      ? anchor.addMonths(-1)
      : (mode === 'week' ? anchor.addDays(-7) : anchor.addDays(-1));
    this.applyViewConfig(true, next);
  }

  nextCalendarRange(): void {
    const mode = this.viewMode();
    const anchor = this.currentViewAnchorDate();
    const next = mode === 'month'
      ? anchor.addMonths(1)
      : (mode === 'week' ? anchor.addDays(7) : anchor.addDays(1));
    this.applyViewConfig(true, next);
  }

  jumpToToday(): void {
    this.applyViewConfig(true, this.localTodayDatePart());
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
      timeZone: DEFAULT_SHOP_TIME_ZONE,
      showWeekends: false,
      holidays: [],
      federalYear: new Date().getFullYear(),
      federalInitialized: false
    };
  }

  private loadPersistedSettings(): void {
    this.settingsApi.getValue<ScheduleSettings>(SCHEDULE_SETTINGS_KEY).subscribe(value => {
      this.applySettings(this.normalizeSettings(value));
      this.settingsLoaded = true;
      this.loadPersistedCalendarView();
      this.loadAll();
    });
  }

  private loadPersistedCalendarView(): void {
    this.userSettings.getValue<string>(SCHEDULE_VIEW_MODE_KEY).subscribe(mode => {
      this.viewMode.set(this.parseCalendarViewMode(mode));
      this.jumpToToday();
    });
  }

  private parseCalendarViewMode(value: unknown): CalendarViewMode {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'week' || raw === 'month' || raw === 'day') return raw;
    return 'day';
  }

  private normalizeSettings(value: unknown): ScheduleSettings {
    const parsed = value && typeof value === 'object' ? (value as Partial<ScheduleSettings>) : {};
    const base = this.defaultSettings();
    return {
      bays: Array.isArray(parsed.bays) && parsed.bays.length ? parsed.bays : base.bays,
      openHour: Number.isFinite(parsed.openHour) ? Number(parsed.openHour) : base.openHour,
      closeHour: Number.isFinite(parsed.closeHour) ? Number(parsed.closeHour) : base.closeHour,
      timeZone: normalizeShopTimeZone(parsed.timeZone),
      showWeekends: typeof parsed.showWeekends === 'boolean' ? parsed.showWeekends : base.showWeekends,
      holidays: Array.isArray(parsed.holidays) ? parsed.holidays.map(v => String(v || '')) : base.holidays,
      federalYear: Number.isFinite(parsed.federalYear) ? Number(parsed.federalYear) : base.federalYear,
      federalInitialized: typeof parsed.federalInitialized === 'boolean' ? parsed.federalInitialized : base.federalInitialized
    };
  }

  private applySettings(s: ScheduleSettings) {
    this.shopTimeZone.set(normalizeShopTimeZone(s.timeZone));
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
      this.settingsHolidays.set(merged);
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
    this.syncNowLine();
  }

  private applyViewConfig(ensureVisible: boolean, anchorDate?: DayPilot.Date): void {
    const mode = this.viewMode();
    const anchor = (anchorDate ? anchorDate.getDatePart() : this.currentViewAnchorDate());
    this.viewAnchor.set(anchor.toString());
    const start = this.alignStartForMode(anchor, mode);

    if (mode === 'month') {
      this.monthConfig.startDate = start;
      this.month?.control.update({ startDate: start });
      this.scheduleMonthViewportHeightUpdate();
      this.hideNowLine();
      return;
    }

    const days = mode === 'week' ? this.weekDayCount(anchor) : 1;
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
    this.syncNowLine();
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
    const stage = scrollable?.closest<HTMLElement>('.scheduler-stage');
    if (!scrollable || !matrix || !stage) {
      this.hideNowLine();
      return;
    }

    this.bindNowLineScrollListener(scrollable);

    const now = new DayPilot.Date(shopWallTime(Date.now(), this.shopTimeZone()));
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

    const stageRect = stage.getBoundingClientRect();
    const matrixRect = matrix.getBoundingClientRect();
    const scrollRect = scrollable.getBoundingClientRect();
    const left = Math.round(matrixRect.left - stageRect.left + pixels.left);
    const minLeft = Math.round(scrollRect.left - stageRect.left);
    const maxLeft = Math.round(scrollRect.right - stageRect.left);

    if (!Number.isFinite(left) || left < minLeft - 2 || left > maxLeft + 2) {
      this.hideNowLine();
      return;
    }

    this.nowLineLeft.set(left);
    this.nowLineTop.set(Math.round(scrollRect.top - stageRect.top));
    this.nowLineHeight.set(Math.max(0, Math.round(scrollRect.height)));
    this.nowLineLabel.set(this.formatNowLineLabel());
    this.showNowLine.set(true);
  }

  private formatNowLineLabel(): string {
    const now = new Date();
    return now.toLocaleTimeString([], { timeZone: this.shopTimeZone(), hour: 'numeric', minute: '2-digit' });
  }

  private currentViewAnchorDate(): DayPilot.Date {
    return new DayPilot.Date(this.viewAnchor()).getDatePart();
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

  private weekDayCount(anchor: DayPilot.Date): number {
    return this.settingsShowWeekends() || this.isWeekendDay(anchor) ? 7 : 5;
  }

  private localTodayDatePart(): DayPilot.Date {
    return new DayPilot.Date(shopWallTime(Date.now(), this.shopTimeZone())).getDatePart();
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

  private persistCalendarViewMode(): void {
    this.userSettings.setValue(SCHEDULE_VIEW_MODE_KEY, this.viewMode()).subscribe({ error: () => {} });
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
    const nowMs = Date.now();
    const timeZone = this.shopTimeZone();
    for (const it of this.items()) {
      const plannedEndMs = shopTimeMillis(it.end, timeZone);
      const actualEndMs = shopTimeMillis(it.actualEnd, timeZone);
      const releasedMs = shopTimeMillis(it.bayReleasedAt, timeZone);
      let effectiveEndMs = plannedEndMs;
      if (actualEndMs && (!effectiveEndMs || actualEndMs < effectiveEndMs)) effectiveEndMs = actualEndMs;
      if (releasedMs && (!effectiveEndMs || releasedMs < effectiveEndMs)) effectiveEndMs = releasedMs;
      const startMs = shopTimeMillis(it.start, timeZone);
      if (!Number.isFinite(startMs) || !Number.isFinite(effectiveEndMs) || effectiveEndMs <= startMs) continue;
      const end = effectiveEndMs === plannedEndMs ? shopWallTime(it.end, timeZone) : shopWallTime(effectiveEndMs, timeZone);
      const isCompleted = !!releasedMs && releasedMs <= nowMs;
      const completedAtLabel = isCompleted
        ? new Date(releasedMs).toLocaleTimeString([], { timeZone, hour: 'numeric', minute: '2-digit' })
        : '';
      const cust = it.customerId ? map[it.customerId] : null;
      const vehicle = it.vehicle || (cust ? this.vehicleLabel(cust) : '');
      const text = it.isBlocked
        ? (it.title || 'Closed')
        : (cust ? `${cust.name || 'Unnamed'}${vehicle ? ' — ' + vehicle : ''}` : 'Unassigned');
      list.push({
        id: it.id,
        start: shopWallTime(it.start, timeZone),
        end,
        resource: it.resource,
        text,
        toolTip: it.notes || '',
        tags: {
          customerId: it.customerId || '',
          isBlocked: !!it.isBlocked,
          completed: isCompleted,
          completedAt: it.bayReleasedAt || '',
          completedAtLabel,
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
    if (!this.settingsLoaded || !this.pendingCustomerId) return;
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

  clearPlanningCustomer(): void {
    this.planningCustomerId.set(null);
  }

  openManualPlanningEditor(): void {
    const customerId = this.planningCustomerId();
    if (!customerId) return;
    const slot = this.defaultSlotForCustomer(customerId);
    this.setCalendarView('day');
    this.openEditor({
      id: null,
      start: slot.start,
      end: slot.end,
      resource: slot.resource,
      customerId,
      isBlocked: false,
      title: '',
      notes: ''
    });
  }

  useSuggestedSlot(slot: SuggestedSlot): void {
    const customerId = this.planningCustomerId();
    if (!customerId) return;
    const minimumDurationMs = 30 * 60 * 1000;
    const busyRows = (this.items() || [])
      .filter(item => String(item.resource || '') === String(slot.resource || ''))
      .map(item => ({
        startMs: this.appointmentWallMillis(item.start),
        endMs: this.appointmentWallMillis(item.end)
      }))
      .filter(row => row.startMs > 0 && row.endMs > row.startMs)
      .sort((a, b) => a.startMs - b.startMs);

    const slotStartMs = this.appointmentWallMillis(slot.start);
    const slotEndMs = this.appointmentWallMillis(slot.end);
    const slotDurationMs = slotStartMs && slotEndMs && slotEndMs > slotStartMs
      ? Math.max(minimumDurationMs, slotEndMs - slotStartMs)
      : minimumDurationMs;
    const computedSegments = slotStartMs
      ? this.buildBusinessSegmentsFromStart(slotStartMs, slotDurationMs, slot.resource, busyRows)
      : null;
    const segments = (slot.segments && slot.segments.length
      ? slot.segments
      : (computedSegments || []).map(segment => ({
          start: new Date(segment.startMs).toISOString().slice(0, 19),
          end: new Date(segment.endMs).toISOString().slice(0, 19)
        })))
      .filter(segment => this.appointmentWallMillis(segment.start) && this.appointmentWallMillis(segment.end) > this.appointmentWallMillis(segment.start));

    if (!segments.length) {
      this.setStatusError('No valid business-hour slot is available for this suggestion. Try another option.');
      return;
    }

    const fallback = this.partsFromLatestPaidInvoice(customerId);
    const partRequests = fallback.parts;
    const notes = '';
    const payloads = segments.map(segment => ({
      start: toLocalDateTimeStorage(segment.start),
      end: toLocalDateTimeStorage(segment.end),
      resource: String(slot.resource || ''),
      customerId,
      isBlocked: false,
      title: '',
      notes,
      partRequests
    }));

    let index = 0;
    let firstCreatedSchedule: ScheduleItem | null = null;
    const createNext = () => {
      if (index >= payloads.length) {
        this.clearPlanningCustomer();
        this.pendingCustomerId = null;
        this.editorOpen.set(false);
        this.loadAll();
        this.setStatusSuccess('Appointment scheduled from suggested slot.');
        if (firstCreatedSchedule) this.queueAppointmentInfoPrompt(firstCreatedSchedule);
        return;
      }

      const payload = payloads[index];
      index += 1;
      this.scheduleApi.create(payload).subscribe({
        next: res => {
          if (!firstCreatedSchedule) {
            firstCreatedSchedule = {
              id: String(res?.id || ''),
              ...payload
            };
          }
          createNext();
        },
        error: () => {
          this.setStatusError('Could not schedule from suggested slot. Please try again.');
        }
      });
    };

    createNext();
  }

  private buildSuggestedSlots(customerId: string | null, limit: number): SuggestedSlot[] {
    if (!customerId) return [];
    const resources = this.resources();
    if (!resources.length) return [];
    const openHour = this.settingsOpenHour();
    const closeHour = this.settingsCloseHour();
    if (!Number.isFinite(openHour) || !Number.isFinite(closeHour) || closeHour <= openHour) return [];
    const intervalMs = 30 * 60 * 1000;
    const durationMs = this.resolveSuggestedDurationMs(customerId);
    const effectiveDurationMs = Math.max(intervalMs, durationMs);
    const now = new Date(this.appointmentWallMillis(Date.now()));
    const startSearch = this.roundUpToInterval(now, intervalMs);
    const dayLimit = 21;
    const byResource = new Map<string, Array<{ startMs: number; endMs: number }>>();

    for (const resource of resources) byResource.set(String(resource.id), []);

    for (const item of this.items()) {
      const resourceId = String(item.resource || '').trim();
      if (!resourceId || !byResource.has(resourceId)) continue;
      const startMs = this.appointmentWallMillis(item.start);
      const endMs = this.appointmentWallMillis(item.end);
      if (!startMs || !endMs || endMs <= startMs) continue;
      byResource.get(resourceId)!.push({ startMs, endMs });
    }

    for (const rows of byResource.values()) {
      rows.sort((a, b) => a.startMs - b.startMs);
    }

    const suggestions: SuggestedSlot[] = [];
    for (let dayOffset = 0; dayOffset < dayLimit && suggestions.length < limit; dayOffset++) {
      const day = new Date(startSearch);
      day.setUTCDate(day.getUTCDate() + dayOffset);
      const dayPilotDate = DayPilot.Date.fromYearMonthDay(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
      if (!this.settingsShowWeekends() && this.isWeekendDay(dayPilotDate)) continue;
      if (this.isHoliday(dayPilotDate)) continue;

      for (const resource of resources) {
        if (suggestions.length >= limit) break;
        const resourceId = String(resource.id);
        const resourceName = String(resource.name || resource.id || 'Bay');
        const dayStart = new Date(day);
        dayStart.setUTCHours(openHour, 0, 0, 0);
        const dayEnd = new Date(day);
        dayEnd.setUTCHours(closeHour, 0, 0, 0);

        let cursorMs = Math.max(dayStart.getTime(), startSearch.getTime());
        const busyRows = byResource.get(resourceId) || [];

        while (cursorMs < dayEnd.getTime() && suggestions.length < limit) {
          const segments = this.buildBusinessSegmentsFromStart(cursorMs, effectiveDurationMs, resourceId, busyRows);
          if (segments && segments.length) {
            const firstSegment = segments[0];
            const lastSegment = segments[segments.length - 1];
            const startDate = new Date(firstSegment.startMs);
            const endDate = new Date(lastSegment.endMs);
            const hoursLabel = this.formatDurationHoursLabel(
              segments.reduce((sum, segment) => sum + Math.max(0, segment.endMs - segment.startMs), 0)
            );
            const spansDays = startDate.toISOString().slice(0, 10) !== endDate.toISOString().slice(0, 10);
            const endLabel = spansDays
              ? `${endDate.toLocaleDateString([], { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })} ${endDate.toLocaleTimeString([], { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })}`
              : endDate.toLocaleTimeString([], { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' });
            const label = `${startDate.toLocaleDateString([], { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })} · ${startDate.toLocaleTimeString([], { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' })} - ${endLabel} · ${resourceName} · ${hoursLabel}`;
            suggestions.push({
              start: startDate.toISOString().slice(0, 19),
              end: endDate.toISOString().slice(0, 19),
              resource: resourceId,
              label,
              segments: segments.map(segment => ({
                start: new Date(segment.startMs).toISOString().slice(0, 19),
                end: new Date(segment.endMs).toISOString().slice(0, 19)
              }))
            });
            break;
          }

          const nextBusy = this.findConflictingInterval(busyRows, cursorMs, dayEnd.getTime());
          if (nextBusy) {
            cursorMs = this.roundUpToInterval(new Date(nextBusy.endMs), intervalMs).getTime();
          } else {
            cursorMs += intervalMs;
          }
        }
      }
    }

    return suggestions;
  }

  private buildBusinessSegmentsFromStart(
    startMs: number,
    durationMs: number,
    resourceId: string,
    busyRows: Array<{ startMs: number; endMs: number }>
  ): Array<{ startMs: number; endMs: number }> | null {
    const openHour = this.settingsOpenHour();
    const closeHour = this.settingsCloseHour();
    const totalDurationMs = Math.max(30 * 60 * 1000, Number(durationMs) || 0);
    if (!Number.isFinite(totalDurationMs) || totalDurationMs <= 0) return null;
    if (!Number.isFinite(openHour) || !Number.isFinite(closeHour) || closeHour <= openHour) return null;

    const segments: Array<{ startMs: number; endMs: number }> = [];
    let remainingMs = totalDurationMs;
    let cursorMs = startMs;
    let guard = 0;

    while (remainingMs > 0 && guard < 500) {
      guard += 1;
      const current = new Date(cursorMs);
      const currentDay = DayPilot.Date.fromYearMonthDay(current.getUTCFullYear(), current.getUTCMonth() + 1, current.getUTCDate());
      if (!this.settingsShowWeekends() && this.isWeekendDay(currentDay)) {
        const nextStart = this.nextBusinessDayStartMs(current);
        if (!nextStart) return null;
        cursorMs = nextStart;
        continue;
      }
      if (this.isHoliday(currentDay)) {
        const nextStart = this.nextBusinessDayStartMs(current);
        if (!nextStart) return null;
        cursorMs = nextStart;
        continue;
      }

      const dayStart = new Date(current);
      dayStart.setUTCHours(openHour, 0, 0, 0);
      const dayEnd = new Date(current);
      dayEnd.setUTCHours(closeHour, 0, 0, 0);

      if (cursorMs < dayStart.getTime()) cursorMs = dayStart.getTime();
      if (cursorMs >= dayEnd.getTime()) {
        const nextStart = this.nextBusinessDayStartMs(current);
        if (!nextStart) return null;
        cursorMs = nextStart;
        continue;
      }

      const chunkEndMs = Math.min(dayEnd.getTime(), cursorMs + remainingMs);
      const conflict = this.findConflictingInterval(busyRows, cursorMs, chunkEndMs);
      if (conflict) return null;

      segments.push({ startMs: cursorMs, endMs: chunkEndMs });
      remainingMs -= (chunkEndMs - cursorMs);
      if (remainingMs <= 0) break;

      const nextStart = this.nextBusinessDayStartMs(current);
      if (!nextStart) return null;
      cursorMs = nextStart;
    }

    if (remainingMs > 0) return null;
    const uniqueResource = String(resourceId || '').trim();
    if (!uniqueResource) return null;
    return segments;
  }

  private nextBusinessDayStartMs(fromDate: Date): number | null {
    const openHour = this.settingsOpenHour();
    if (!Number.isFinite(openHour)) return null;
    const cursor = new Date(fromDate);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    cursor.setUTCHours(openHour, 0, 0, 0);

    for (let i = 0; i < 120; i++) {
      const day = new Date(cursor);
      day.setUTCDate(cursor.getUTCDate() + i);
      day.setUTCHours(openHour, 0, 0, 0);
      const pilotDay = DayPilot.Date.fromYearMonthDay(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
      if (!this.settingsShowWeekends() && this.isWeekendDay(pilotDay)) continue;
      if (this.isHoliday(pilotDay)) continue;
      return day.getTime();
    }
    return null;
  }

  private findConflictingInterval(
    busyRows: Array<{ startMs: number; endMs: number }>,
    startMs: number,
    endMs: number
  ): { startMs: number; endMs: number } | null {
    for (const row of busyRows) {
      if (row.endMs <= startMs) continue;
      if (row.startMs >= endMs) break;
      return row;
    }
    return null;
  }

  private roundUpToInterval(date: Date, intervalMs: number): Date {
    const stamp = date.getTime();
    const rounded = Math.ceil(stamp / intervalMs) * intervalMs;
    return new Date(rounded);
  }

  private resolveSuggestedDurationMs(customerId: string): number {
    const defaultDurationMs = 4 * 60 * 60 * 1000;
    const minimumDurationMs = 30 * 60 * 1000;
    const customerKey = String(customerId || '').trim();
    if (!customerKey) return defaultDurationMs;

    const docs = this.invoicesData.forCustomer({ id: customerKey })
      .map(card => this.invoicesData.getInvoiceById(card.id))
      .filter((doc): doc is InvoiceDetail => !!doc)
      .filter(doc => doc.stage !== 'canceled' && doc.stage !== 'expired' && doc.stage !== 'declined');

    if (!docs.length) return defaultDurationMs;

    docs.sort((a, b) => {
      const stageDiff = this.invoiceStagePriority(b.stage) - this.invoiceStagePriority(a.stage);
      if (stageDiff !== 0) return stageDiff;
      return this.toMillis(b.updatedAt || b.createdAt || '') - this.toMillis(a.updatedAt || a.createdAt || '');
    });

    const selected = docs[0];
    const hours = (selected.lineItems || [])
      .filter(line => line.type === 'labor')
      .reduce((sum, line) => sum + Math.max(0, Number(line.quantity || 0)), 0);

    if (!Number.isFinite(hours) || hours <= 0) return defaultDurationMs;

    const computedDurationMs = hours * 60 * 60 * 1000;
    return Math.max(minimumDurationMs, computedDurationMs);
  }

  private invoiceStagePriority(stage: string | null | undefined): number {
    const normalized = String(stage || '').trim().toLowerCase();
    if (normalized === 'completed') return 6;
    if (normalized === 'accepted') return 5;
    if (normalized === 'sent') return 4;
    if (normalized === 'draft') return 3;
    if (normalized === 'declined') return 2;
    if (normalized === 'expired') return 1;
    if (normalized === 'canceled') return 0;
    return -1;
  }

  private formatDurationHoursLabel(durationMs: number): string {
    const hours = durationMs / (60 * 60 * 1000);
    if (!Number.isFinite(hours) || hours <= 0) return '0h';
    const hasFraction = Math.abs(hours - Math.round(hours)) > 0.001;
    return `${hasFraction ? hours.toFixed(1) : Math.round(hours)}h`;
  }

  private defaultSlot(): { start: string; end: string; resource: string } {
    return this.defaultSlotForCustomer('');
  }

  private defaultSlotForCustomer(customerId: string): { start: string; end: string; resource: string } {
    const openHour = this.settingsOpenHour();
    const closeHour = this.settingsCloseHour();
    let start = new Date(this.appointmentWallMillis(Date.now()));
    start.setUTCMinutes(0, 0, 0);
    const day = new DayPilot.Date(start.toISOString().slice(0, 19)).getDatePart();
    if (start.getUTCHours() >= closeHour || this.isHoliday(day) ||
        (!this.settingsShowWeekends() && this.isWeekendDay(day))) {
      const nextStart = this.nextBusinessDayStartMs(start);
      if (nextStart !== null) start = new Date(nextStart);
    }
    if (start.getUTCHours() < openHour) start.setUTCHours(openHour, 0, 0, 0);
    const durationMs = customerId ? this.resolveSuggestedDurationMs(customerId) : 4 * 60 * 60 * 1000;
    const closing = new Date(start);
    closing.setUTCHours(closeHour, 0, 0, 0);
    const end = new Date(Math.min(closing.getTime(), start.getTime() + Math.max(30 * 60 * 1000, durationMs)));
    const resource = (this.resources()[0]?.id || 'bay-1').toString();
    return {
      start: start.toISOString().slice(0, 19),
      end: end.toISOString().slice(0, 19),
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
    partRequests?: PartRequest[];
  }) {
    this.editorId.set(data.id);
    this.editorStart.set(toLocalDateTimeInput(shopWallTime(data.start, this.shopTimeZone())));
    this.editorEnd.set(toLocalDateTimeInput(shopWallTime(data.end, this.shopTimeZone())));
    this.editorResource.set(data.resource);
    this.editorCustomerId.set(data.customerId || null);
    this.editorBlocked.set(!!data.isBlocked);
    this.editorTitle.set(data.title || '');
    this.editorNotes.set(data.notes || '');
    const incomingParts = this.normalizePartRequests(data.partRequests || []);
    const customerId = String(data.customerId || '').trim();
    let effectiveParts = incomingParts;
    let sourceHint = '';
    if (!effectiveParts.length && !data.isBlocked && customerId) {
      const fallback = this.partsFromLatestPaidInvoice(customerId);
      effectiveParts = fallback.parts;
      sourceHint = fallback.invoiceNumber
        ? `Auto-filled from paid invoice ${fallback.invoiceNumber}.`
        : '';
    }
    this.editorParts.set(this.formatPartRequestsForEditor(effectiveParts));
    this.editorPartsSourceHint.set(sourceHint);
    this.editorRepeatEvery.set(0);
    this.editorRepeatCount.set(1);
    this.editorError.set('');
    this.markEditorPristine();
    this.editorOpen.set(true);
  }

  closeEditor() {
    this.editorOpen.set(false);
    this.editorError.set('');
    this.editorPartsSourceHint.set('');
  }

  onEditorCustomerChange(value: string | null | undefined): void {
    const nextCustomerId = String(value || '').trim() || null;
    this.editorCustomerId.set(nextCustomerId);
    if (this.editorBlocked() || !nextCustomerId) return;
    if (String(this.editorParts() || '').trim()) return;
    const fallback = this.partsFromLatestPaidInvoice(nextCustomerId);
    this.editorParts.set(this.formatPartRequestsForEditor(fallback.parts));
    this.editorPartsSourceHint.set(
      fallback.invoiceNumber ? `Auto-filled from paid invoice ${fallback.invoiceNumber}.` : ''
    );
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
    let partRequests = isBlocked ? [] : this.parsePartRequestsFromEditor(this.editorParts());
    if (!isBlocked && customerId && !partRequests.length) {
      partRequests = this.partsFromLatestPaidInvoice(customerId).parts;
    }
    const repeatEvery = Math.max(0, Number(this.editorRepeatEvery()) || 0);
    const repeatCount = Math.max(1, Number(this.editorRepeatCount()) || 1);

    const base = { start, end, resource, customerId, isBlocked, title, notes, partRequests };
    const id = this.editorId();

    if (id) {
      const existing = this.items().find(item => String(item.id || '') === String(id)) || null;
      this.scheduleApi.update({ id, ...base }).subscribe({
        next: () => {
          this.loadAll();
          this.editorOpen.set(false);
          this.setStatusSuccess('Appointment saved.');
          this.queueAppointmentInfoPrompt({
            id,
            ...base,
            appointmentInfoSentAt: existing?.appointmentInfoSentAt || '',
            appointmentInfoSentVia: existing?.appointmentInfoSentVia || '',
            appointmentInfoMessage: existing?.appointmentInfoMessage || '',
            appointmentInfoSentScheduleStart: existing?.appointmentInfoSentScheduleStart || '',
            appointmentInfoSentScheduleEnd: existing?.appointmentInfoSentScheduleEnd || '',
            appointmentInfoSentResource: existing?.appointmentInfoSentResource || ''
          });
        },
        error: () => {
          this.editorError.set('Could not save appointment. Try again.');
          this.setStatusError('Could not save appointment.');
        }
      });
      return;
    }

    let firstCreatedSchedule: ScheduleItem | null = null;
    const createOne = (s: string, e: string) =>
      this.scheduleApi.create({ ...base, start: s, end: e }).subscribe({
        next: res => {
          if (!firstCreatedSchedule) {
            firstCreatedSchedule = {
              id: String(res?.id || ''),
              ...base,
              start: s,
              end: e
            };
            this.queueAppointmentInfoPrompt(firstCreatedSchedule);
          }
          this.loadAll();
        },
        error: () => {
          this.editorError.set('Could not save appointment. Try again.');
          this.setStatusError('Could not save appointment.');
        }
      });

    createOne(start, end);
    if (!id && customerId && customerId === this.planningCustomerId()) {
      this.clearPlanningCustomer();
    }

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
    this.editorPartsSourceHint.set('');
    this.setStatusSuccess('Appointment saved.');
  }

  private queueAppointmentInfoPrompt(schedule: ScheduleItem): void {
    if (!schedule || schedule.isBlocked || !String(schedule.customerId || '').trim()) return;
    if (this.isAppointmentInfoCurrent(schedule)) return;
    window.setTimeout(() => this.openAppointmentInfoPrompt(schedule), 180);
  }

  private openAppointmentInfoPrompt(schedule: ScheduleItem): void {
    const customer = this.customerForSchedule(schedule);
    if (!customer) return;
    this.appointmentInfoSchedule.set(schedule);
    this.appointmentInfoSendEmail.set(!!String(customer.email || '').trim());
    this.appointmentInfoSendSms.set(!!String(customer.phone || '').trim());
    this.appointmentInfoMessage.set(this.defaultAppointmentInfoMessage(schedule));
    this.appointmentInfoError.set('');
    this.appointmentInfoModalOpen.set(true);
  }

  closeAppointmentInfoModal(): void {
    if (this.appointmentInfoSending()) return;
    this.appointmentInfoModalOpen.set(false);
    this.appointmentInfoSchedule.set(null);
    this.appointmentInfoError.set('');
  }

  appointmentInfoCustomer(): UICustomer | null {
    const schedule = this.appointmentInfoSchedule();
    return schedule ? this.customerForSchedule(schedule) : null;
  }

  appointmentInfoEmailAddress(): string {
    return String(this.appointmentInfoCustomer()?.email || '').trim();
  }

  appointmentInfoPhoneNumber(): string {
    return String(this.appointmentInfoCustomer()?.phone || '').trim();
  }

  appointmentInfoWhenLabel(): string {
    const schedule = this.appointmentInfoSchedule();
    return schedule ? this.appointmentTimeLabel(schedule) : '';
  }

  appointmentInfoSmsPreview(): string {
    const message = String(this.appointmentInfoMessage() || '').trim();
    return message;
  }

  appointmentInfoEmailPreview(): string {
    const schedule = this.appointmentInfoSchedule();
    const message = String(this.appointmentInfoMessage() || '').trim();
    if (!schedule) return message;
    return `${message}\n\nAppointment: ${this.appointmentTimeLabel(schedule)}\nGoogle Calendar and Outlook add-to-calendar links will be included.`;
  }

  appointmentInfoCanSend(): boolean {
    if (this.appointmentInfoSending()) return false;
    if (!this.appointmentInfoSchedule()) return false;
    if (!String(this.appointmentInfoMessage() || '').trim()) return false;
    return (this.appointmentInfoSendEmail() && !!this.appointmentInfoEmailAddress())
      || (this.appointmentInfoSendSms() && !!this.appointmentInfoPhoneNumber());
  }

  private customerForSchedule(schedule: ScheduleItem | null): UICustomer | null {
    const id = String(schedule?.customerId || '').trim();
    return id ? (this.customersById()[id] || null) : null;
  }

  private isAppointmentInfoCurrent(schedule: ScheduleItem | null): boolean {
    return !!schedule?.appointmentInfoSentAt;
  }

  private defaultAppointmentInfoMessage(schedule: ScheduleItem): string {
    const customer = this.customerForSchedule(schedule);
    const firstName = String(customer?.firstName || customer?.name?.split(/\s+/)[0] || 'there').trim();
    return `Hi ${firstName}, your appointment with ${this.businessDisplayName()} is ${this.appointmentTimeLabel(schedule)}. If you need to change it, please call us.`;
  }

  private businessDisplayName(): string {
    return String(this.businessProfile.companyName() || 'our team').trim() || 'our team';
  }

  private businessLocation(): string {
    return String(this.businessProfile.companyAddress() || '').trim();
  }

  private appointmentTimeLabel(schedule: ScheduleItem): string {
    return formatShopAppointment(schedule.start, schedule.end, this.shopTimeZone());
  }

  private calendarDateParam(value: string): string {
    return shopCalendarIso(value, this.shopTimeZone()).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  }

  private calendarDetails(schedule: ScheduleItem): string {
    const customer = this.customerForSchedule(schedule);
    const vehicle = schedule.vehicle || (customer ? this.vehicleLabel(customer) : '');
    const lines = [
      `Appointment with ${this.businessDisplayName()}.`,
      customer?.name ? `Customer: ${customer.name}` : '',
      vehicle ? `Vehicle: ${vehicle}` : '',
      String(schedule.notes || '').trim() ? `Notes: ${String(schedule.notes || '').trim()}` : '',
      'Call us if you need to change this appointment.'
    ];
    return lines.filter(Boolean).join('\n');
  }

  private googleCalendarUrl(schedule: ScheduleItem): string {
    const start = this.calendarDateParam(schedule.start || '');
    const end = this.calendarDateParam(schedule.end || schedule.start || '');
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: `${this.businessDisplayName()} appointment`,
      dates: `${start}/${end}`,
      details: this.calendarDetails(schedule),
      location: this.businessLocation()
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  private outlookCalendarUrl(schedule: ScheduleItem): string {
    const timeZone = this.shopTimeZone();
    const params = new URLSearchParams({
      path: '/calendar/action/compose',
      rru: 'addevent',
      subject: `${this.businessDisplayName()} appointment`,
      startdt: shopCalendarIso(schedule.start, timeZone),
      enddt: shopCalendarIso(schedule.end || schedule.start, timeZone),
      body: this.calendarDetails(schedule),
      location: this.businessLocation()
    });
    return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
  }

  private appointmentEmailHtml(message: string, schedule: ScheduleItem, portalUrl: string): string {
    const customer = this.customerForSchedule(schedule);
    const vehicle = schedule.vehicle || (customer ? this.vehicleLabel(customer) : '');
    const googleUrl = this.googleCalendarUrl(schedule);
    const outlookUrl = this.outlookCalendarUrl(schedule);
    return `<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.55;color:#111827;">
      <p>${this.escapeHtml(message)}</p>
      <table style="border-collapse:collapse;margin:18px 0;width:100%;max-width:560px;">
        <tr><td style="padding:8px 10px;border:1px solid #e5e7eb;font-weight:700;">Appointment</td><td style="padding:8px 10px;border:1px solid #e5e7eb;">${this.escapeHtml(this.appointmentTimeLabel(schedule))}</td></tr>
        ${vehicle ? `<tr><td style="padding:8px 10px;border:1px solid #e5e7eb;font-weight:700;">Vehicle</td><td style="padding:8px 10px;border:1px solid #e5e7eb;">${this.escapeHtml(vehicle)}</td></tr>` : ''}
        ${this.businessLocation() ? `<tr><td style="padding:8px 10px;border:1px solid #e5e7eb;font-weight:700;">Location</td><td style="padding:8px 10px;border:1px solid #e5e7eb;">${this.escapeHtml(this.businessLocation())}</td></tr>` : ''}
      </table>
      ${portalUrl ? `<p><a href="${this.escapeHtml(portalUrl)}">Open your service visit</a></p>` : ''}
      <p>
        <a href="${this.escapeHtml(googleUrl)}" style="display:inline-block;margin:0 10px 10px 0;padding:10px 14px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;">Add to Google Calendar</a>
        <a href="${this.escapeHtml(outlookUrl)}" style="display:inline-block;margin:0 10px 10px 0;padding:10px 14px;background:#111827;color:#fff;text-decoration:none;border-radius:6px;font-weight:700;">Add to Outlook Calendar</a>
      </p>
    </div>`;
  }

  async sendAppointmentInfo(): Promise<void> {
    const schedule = this.appointmentInfoSchedule();
    const customer = this.appointmentInfoCustomer();
    if (!schedule || !customer) {
      this.appointmentInfoError.set('Missing appointment details.');
      return;
    }
    const message = String(this.appointmentInfoMessage() || '').trim();
    if (!message) {
      this.appointmentInfoError.set('Enter a message before sending.');
      return;
    }
    if (this.appointmentInfoSending()) return;
    const sendEmail = this.appointmentInfoSendEmail();
    const sendSms = this.appointmentInfoSendSms();
    const email = this.appointmentInfoEmailAddress();
    const phone = this.appointmentInfoPhoneNumber();
    if ((sendEmail && !email) || (sendSms && !phone)) {
      this.appointmentInfoError.set('A selected channel is missing customer contact information.');
      return;
    }
    if (!sendEmail && !sendSms) {
      this.appointmentInfoError.set('Choose Email, SMS, or both.');
      return;
    }
    this.appointmentInfoSending.set(true);
    this.appointmentInfoError.set('');
    const portalUrl = await this.customerPortal.appointmentUrl(schedule.workItemId);
    const visitMessage = portalUrl ? `\n\nYour visit: ${portalUrl}` : '';
    const sends: Array<Promise<'email' | 'sms'>> = [];
    const customerId = String(customer.id || '').trim();
    const customerName = String(customer.name || '').trim() || 'Customer';

    if (sendEmail) {
      const plain = `${message}\n\nAppointment: ${this.appointmentTimeLabel(schedule)}\n\nAdd to Google Calendar: ${this.googleCalendarUrl(schedule)}\nAdd to Outlook Calendar: ${this.outlookCalendarUrl(schedule)}${visitMessage}`;
      sends.push(firstValueFrom(this.emailApi.sendToCustomer({
        customerId,
        customerName,
        to: email,
        subject: `${this.businessDisplayName()} appointment details`,
        message: plain,
        html: this.appointmentEmailHtml(message, schedule, portalUrl),
        skipFooterTerms: true
      })).then(() => 'email' as const));
    }

    if (sendSms) {
      sends.push(firstValueFrom(this.smsApi.sendToCustomer({
        customerId,
        customerName,
        to: phone,
        message: message + visitMessage
      })).then(() => 'sms' as const));
    }

    const settled = await Promise.allSettled(sends);
    const sentVia = settled
      .filter((result): result is PromiseFulfilledResult<'email' | 'sms'> => result.status === 'fulfilled')
      .map(result => result.value);

    if (!sentVia.length) {
      const reason = settled.find(result => result.status === 'rejected') as PromiseRejectedResult | undefined;
      this.appointmentInfoSending.set(false);
      this.appointmentInfoError.set(String(reason?.reason?.message || reason?.reason || 'Could not send appointment info.'));
      return;
    }

    const partialFailure = sentVia.length < sends.length
      ? (settled.find(result => result.status === 'rejected') as PromiseRejectedResult | undefined)
      : null;

    try {
      const sentAt = new Date().toISOString();
      await firstValueFrom(this.scheduleApi.update({
        id: schedule.id,
        appointmentInfoSentAt: sentAt,
        appointmentInfoSentVia: sentVia.join(','),
        appointmentInfoMessage: message,
        appointmentInfoSentScheduleStart: String(schedule.start || ''),
        appointmentInfoSentScheduleEnd: String(schedule.end || ''),
        appointmentInfoSentResource: String(schedule.resource || '')
      }));
      this.items.update(rows => (rows || []).map(row => String(row.id || '').trim() === String(schedule.id || '').trim()
        ? {
            ...row,
            appointmentInfoSentAt: sentAt,
            appointmentInfoSentVia: sentVia.join(','),
            appointmentInfoMessage: message,
            appointmentInfoSentScheduleStart: String(schedule.start || ''),
            appointmentInfoSentScheduleEnd: String(schedule.end || ''),
            appointmentInfoSentResource: String(schedule.resource || '')
          }
        : row
      ));
      this.appointmentInfoSending.set(false);
      this.closeAppointmentInfoModal();
      this.loadAll();
      this.setStatusSuccess(partialFailure
        ? `Scheduled info sent by ${sentVia.join(' and ')}. Another channel failed: ${String(partialFailure.reason?.message || partialFailure.reason || 'Unknown error')}.`
        : 'Scheduled info sent.');
    } catch (error: any) {
      this.appointmentInfoError.set(error?.message || 'Sent, but could not update the schedule record.');
    } finally {
      this.appointmentInfoSending.set(false);
    }
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
      timeZone: this.shopTimeZone(),
      showWeekends: !!this.settingsShowWeekends(),
      holidays: this.settingsHolidays(),
      federalYear: this.settingsFederalYear(),
      federalInitialized: true
    };
    this.settingsApi.setValue(SCHEDULE_SETTINGS_KEY, s).subscribe({
      next: () => {
        this.applySettings(s);
        this.settingsOpen.set(false);
        this.setStatusSuccess('Schedule settings saved.');
      },
      error: () => this.settingsError.set('Could not save schedule settings.')
    });
  }

  private applySettingsPreview() {
    const resources = this.settingsBays().map(b => ({ id: b.id, name: b.name }));
    this.resources.set(resources);
    this.config.resources = resources;
    if (this.scheduler?.control) {
      this.scheduler.control.update({ resources });
    }
    this.syncNowLine();
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
    const startMs = shopTimeMillis(start, this.shopTimeZone());
    const endMs = shopTimeMillis(end, this.shopTimeZone());
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
      return 'End must be after start.';
    }
    if (this.editorBlocked() && !this.editorTitle().trim()) {
      return 'Block label is required when blocking a bay.';
    }
    return '';
  }

  canSaveEditor(): boolean {
    if (this.editorValidationError()) return false;
    // New appointments (no existing id) should be saveable immediately after selecting a suggested slot.
    if (!this.editorId()) return true;
    return this.editorDirty();
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
    this.syncNowLine();
  }

  private formatPartRequestsForEditor(parts: PartRequest[]): string {
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

  private parsePartRequestsFromEditor(text: string): PartRequest[] {
    const rows = String(text || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
    const out: PartRequest[] = [];

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

  private normalizePartRequests(parts: PartRequest[]): PartRequest[] {
    if (!Array.isArray(parts)) return [];
    return parts
      .map(part => ({
        partName: String(part?.partName || '').trim(),
        qty: Math.max(1, Math.floor(Number(part?.qty || 1))),
        vendorHint: String(part?.vendorHint || '').trim(),
        sku: String(part?.sku || '').trim(),
        note: String(part?.note || '').trim()
      }))
      .filter(part => !!part.partName)
      .slice(0, 40);
  }

  private partsFromLatestPaidInvoice(customerId: string): { invoiceNumber: string; parts: PartRequest[] } {
    const lookupId = String(customerId || '').trim();
    if (!lookupId) return { invoiceNumber: '', parts: [] };

    const matches = this.invoicesData.forCustomer({ id: lookupId })
      .map(card => this.invoicesData.getInvoiceById(card.id))
      .filter((doc): doc is InvoiceDetail => !!doc)
      .filter(doc => doc.documentType === 'invoice')
      .filter(doc => doc.stage === 'accepted' || doc.stage === 'completed');

    if (!matches.length) return { invoiceNumber: '', parts: [] };

    matches.sort((a, b) => {
      const aMs = this.toMillis(a.updatedAt || a.createdAt || '');
      const bMs = this.toMillis(b.updatedAt || b.createdAt || '');
      return bMs - aMs;
    });

    const latest = matches[0];
    const parts = this.normalizePartRequests(
      (latest.lineItems || [])
        .filter(item => String(item.type || '').trim().toLowerCase() === 'part')
        .map(item => ({
          partName: String(item.description || '').trim() || String(item.code || '').trim(),
          qty: Math.max(1, Number(item.quantity || 1)),
          sku: String(item.code || '').trim(),
          vendorHint: '',
          note: ''
        }))
    );

    return {
      invoiceNumber: String(latest.invoiceNumber || '').trim(),
      parts
    };
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

  private appointmentWallMillis(value: string | number): number {
    return Date.parse(`${shopWallTime(value, this.shopTimeZone())}Z`) || 0;
  }

  private toMillis(value: string | null | undefined): number {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : 0;
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
