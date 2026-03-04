import { Component, signal, computed, effect, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import {
  IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton,
  IonItem, IonLabel, IonInput, IonSpinner, IonIcon, IonModal,
  IonList, IonPopover, IonSelect, IonSelectOption, IonFooter
} from '@ionic/angular/standalone';
import { FormsModule } from '@angular/forms';
import {
  CdkDropList, CdkDropListGroup, CdkDrag, CdkDragDrop,
  moveItemInArray, transferArrayItem
} from '@angular/cdk/drag-drop';
import { LanesApi, Lane } from '../../services/lanes-api.service';
import { WorkItemsApi, WorkItem } from '../../services/workitems-api.service';
import { CustomersApi, Customer } from '../../services/customers-api.service';
import { ScheduleApi, ScheduleItem } from '../../services/schedule-api.service';
import { SmsApiService } from '../../services/sms-api.service';
import { EmailApiService } from '../../services/email-api.service';
import CustomerModalComponent from '../../components/customer/customer-modal/customer-modal.component';
import ScheduleModalComponent from '../../components/schedule/schedule-modal/schedule-modal.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { addIcons } from 'ionicons';
import {
  settingsOutline,
  ellipsisVertical,
  addOutline,
  reorderTwoOutline,
  checkmarkCircle
} from 'ionicons/icons';
import { HttpClient } from '@angular/common/http';
import { UserScopedSettingsService } from '../../services/user-scoped-settings.service';
import { catchError, forkJoin, of } from 'rxjs';

type ColorOpt = { label: string; hex: string };
const LANE_COLORS_SETTING_KEY = 'dashboard.laneColors';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton,
    IonItem, IonLabel, IonInput, IonSpinner, IonIcon, IonModal,
    IonList, IonPopover, IonSelect, IonSelectOption, IonFooter,
    CdkDropList, CdkDropListGroup, CdkDrag,
    CustomerModalComponent,
    ScheduleModalComponent,
    UserMenuComponent,
    CompanySwitcherComponent
  ],
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export default class DashboardComponent implements OnDestroy {
  lanes = signal<Lane[]>([]);
  laneIds = computed(() => this.lanes().map(l => l.id));
  items = signal<Record<string, WorkItem[]>>({});
  customersMap = signal<Record<string, Customer>>({});
  allCustomers = signal<Customer[]>([]);
  scheduleItems = signal<ScheduleItem[]>([]);
  loading = signal(false);
  status = signal('');
  newLane = signal('');
  expanded = signal<Record<string, boolean>>({});
  laneColors = signal<Record<string, string>>({});
  laneMenuOpen = signal(false);
  laneMenuEvent = signal<any>(null);
  laneMenuLaneId = signal<string | null>(null);
  renameValue = signal('');
  renameOpen = signal(false);
  deleteOpen = signal(false);
  deleteTargetId = signal<string | null>(null);
  deleteTargetName = signal<string>('');
  deleteTargetCount = signal(0);
  cardMenuOpen = signal(false);
  cardMenuEvent = signal<any>(null);
  cardMenuItemId = signal<string | null>(null);
  removeCustomerOpen = signal(false);
  removeCustomerItemId = signal<string | null>(null);
  removeCustomerCustomerId = signal<string>('');
  customerModalInitialNotes = signal<string | null>(null);
  searchOpen = signal(false);
  searchLaneId = signal<string | null>(null);
  searchTerm = signal('');
  statusFading = signal(false);
  customerModalOpen = signal(false);
  customerModalId = signal<string | null>(null);
  customerModalMode = signal<'add' | 'edit'>('add');
  laneToLinkAfterSave = signal<string | null>(null);
  apiStatus = signal<'unknown' | 'up' | 'down'>('unknown');
  settingsOpen = signal(false);
  scheduleModalOpen = signal(false);
  scheduleModalCustomerId = signal<string | null>(null);
  unreadActivityByCustomer = signal<Record<string, number>>({});
  unreadEmailByCustomer = signal<Record<string, number>>({});
  unreadSmsIdsByCustomer = signal<Record<string, string[]>>({});
  unreadEmailIdsByCustomer = signal<Record<string, string[]>>({});
  isMobileLayout = signal(false);

  searchResults = computed(() => {
    const q = this.searchTerm().trim().toLowerCase();
    if (!q) return this.recentCustomers();
    const list = this.allCustomers();
    return list.filter(c => {
      const n = (c.name || '').toLowerCase();
      const p = (c.phone || '').toLowerCase();
      const e = (c.email || '').toLowerCase();
      return n.includes(q) || p.includes(q) || e.includes(q);
    }).slice(0, 50);
  });

  palette: ColorOpt[] = [
    { label: 'White',  hex: '#ffffff' },
    { label: 'Black',  hex: '#000000' },
    { label: 'Silver', hex: '#c0c0c0' },
    { label: 'Gray',   hex: '#808080' },
    { label: 'Red',    hex: '#d32f2f' },
    { label: 'Blue',   hex: '#1976d2' },
    { label: 'Green',  hex: '#388e3c' },
    { label: 'Yellow', hex: '#fbc02d' },
    { label: 'Orange', hex: '#f57c00' },
    { label: 'Brown',  hex: '#795548' }
  ];

  constructor(
    private lanesApi: LanesApi,
    private itemsApi: WorkItemsApi,
    private customersApi: CustomersApi,
    private scheduleApi: ScheduleApi,
    private smsApi: SmsApiService,
    private emailApi: EmailApiService,
    private http: HttpClient,
    private userSettings: UserScopedSettingsService,
    private router: Router
  ) {
    addIcons({
      'settings-outline': settingsOutline,
      'ellipsis-vertical': ellipsisVertical,
      'add-outline': addOutline,
      'reorder-two-outline': reorderTwoOutline,
      'checkmark-circle': checkmarkCircle
    });

    this.updateResponsiveLayout();
    effect(() => {
      this.userSettings.scope();
      this.loadLaneColors();
    });
    this.loadAll();
    this.checkApi();
    this.refreshUnreadActivity();
    this.apiCheckTimer = setInterval(() => this.checkApi(), 600000);
    this.unreadActivityTimer = setInterval(() => this.refreshUnreadActivity(), 5000);

    effect(() => {
      const value = this.laneColors();
      if (!this.laneColorsLoaded) return;
      if (this.laneColorPersistTimer) clearTimeout(this.laneColorPersistTimer);
      this.laneColorPersistTimer = setTimeout(() => {
        this.userSettings.setValue(LANE_COLORS_SETTING_KEY, value).subscribe({ error: () => {} });
      }, 120);
    });

    effect(() => {
      const msg = this.status();
      if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = null; }
      if (this.statusFadeTimer) { clearTimeout(this.statusFadeTimer); this.statusFadeTimer = null; }
      if (msg) {
        this.statusFading.set(false);
        this.statusFadeTimer = setTimeout(() => this.statusFading.set(true), 2600);
        this.statusTimer = setTimeout(() => {
          if (this.status() === msg) this.status.set('');
        }, 3000);
      }
    });
  }

  private statusTimer: any = null;
  private statusFadeTimer: any = null;
  private apiCheckTimer: any = null;
  private unreadActivityTimer: any = null;
  private laneColorPersistTimer: any = null;
  private laneColorsLoadToken = 0;
  private laneColorsLoaded = false;

  ngOnDestroy() {
    if (this.apiCheckTimer) { clearInterval(this.apiCheckTimer); this.apiCheckTimer = null; }
    if (this.unreadActivityTimer) { clearInterval(this.unreadActivityTimer); this.unreadActivityTimer = null; }
    if (this.laneColorPersistTimer) { clearTimeout(this.laneColorPersistTimer); this.laneColorPersistTimer = null; }
  }

  @HostListener('window:resize')
  onWindowResize() {
    this.updateResponsiveLayout();
  }

  private updateResponsiveLayout() {
    if (typeof window === 'undefined') return;
    this.isMobileLayout.set(window.innerWidth <= 900);
  }

  private checkApi() {
    this.http.get<{ ok: boolean }>('/api/ping').subscribe({
      next: () => this.apiStatus.set('up'),
      error: () => this.apiStatus.set('down')
    });
  }

  private refreshUnreadActivity(): void {
    this.pruneExpiredCompletedFromBoard();

    this.smsApi.listInbox().subscribe({
      next: res => {
        const items = Array.isArray(res.items) ? res.items : [];
        const map: Record<string, number> = {};
        const idsByCustomer: Record<string, string[]> = {};
        for (const item of items) {
          const customerId = (item.customerId || '').trim();
          if (!customerId) continue;
          map[customerId] = (map[customerId] || 0) + 1;
          if (item.id) {
            if (!idsByCustomer[customerId]) idsByCustomer[customerId] = [];
            idsByCustomer[customerId].push(item.id);
          }
        }
        this.unreadActivityByCustomer.set(map);
        this.unreadSmsIdsByCustomer.set(idsByCustomer);
      }
    });

    this.emailApi.listInbox().subscribe({
      next: res => {
        const items = Array.isArray(res.items) ? res.items : [];
        const map: Record<string, number> = {};
        const idsByCustomer: Record<string, string[]> = {};
        for (const item of items) {
          const customerId = (item.customerId || '').trim();
          if (!customerId) continue;
          map[customerId] = (map[customerId] || 0) + 1;
          if (item.id) {
            if (!idsByCustomer[customerId]) idsByCustomer[customerId] = [];
            idsByCustomer[customerId].push(item.id);
          }
        }
        this.unreadEmailByCustomer.set(map);
        this.unreadEmailIdsByCustomer.set(idsByCustomer);
      }
    });
  }

  openSettings() {
    this.settingsOpen.set(true);
  }

  laneStageKey(lane: Lane | null | undefined): string {
    const explicit = (lane?.stageKey || '').trim().toLowerCase();
    if (explicit === 'quote') return 'lead';
    if (explicit) return explicit;
    const name = (lane?.name || '').trim().toLowerCase();
    if (!name) return 'custom';
    if (/lead|quote|estimate/.test(name)) return 'lead';
    if (/sched|appointment|calendar/.test(name)) return 'scheduled';
    if (/in[- ]?progress|work in progress|progress/.test(name)) return 'inprogress';
    if (/complete|completed|done|pickup|ready/.test(name)) return 'completed';
    return 'custom';
  }

  isProtectedLane(lane: Lane | null | undefined): boolean {
    if (!lane) return false;
    if (lane.protected) return true;
    const stageKey = this.laneStageKey(lane);
    return stageKey === 'lead' || stageKey === 'scheduled' || stageKey === 'inprogress' || stageKey === 'completed';
  }

  isProtectedLaneById(laneId: string | null): boolean {
    if (!laneId) return false;
    const lane = this.lanes().find(item => item.id === laneId) || null;
    return this.isProtectedLane(lane);
  }

  isInProgressLane(lane: Lane | null | undefined): boolean {
    return this.laneStageKey(lane) === 'inprogress';
  }

  isCompletedLane(lane: Lane | null | undefined): boolean {
    return this.laneStageKey(lane) === 'completed';
  }

  private isInProgressLaneById(laneId: string): boolean {
    const lane = this.lanes().find(item => item.id === laneId) || null;
    return this.isInProgressLane(lane);
  }

  private isCompletedLaneById(laneId: string): boolean {
    const lane = this.lanes().find(item => item.id === laneId) || null;
    return this.isCompletedLane(lane);
  }

  private isScheduleRequiredLaneById(laneId: string): boolean {
    const lane = this.lanes().find(item => item.id === laneId) || null;
    const stage = this.laneStageKey(lane);
    return stage === 'scheduled' || stage === 'inprogress' || stage === 'completed';
  }

  private inProgressLaneId(): string | null {
    const lane = this.lanes().find(item => this.isInProgressLane(item));
    return lane?.id || null;
  }

  private workflowLaneStage(stageKey: string): boolean {
    return stageKey === 'lead' || stageKey === 'scheduled' || stageKey === 'inprogress' || stageKey === 'completed';
  }

  private isWorkflowStatusLane(lane: Lane | null | undefined): boolean {
    if (!lane) return false;
    return this.workflowLaneStage(this.laneStageKey(lane));
  }

  private findItemById(itemId: string | null): WorkItem | null {
    if (!itemId) return null;
    for (const rows of Object.values(this.items())) {
      const found = (rows || []).find(item => item.id === itemId);
      if (found) return found;
    }
    return null;
  }

  private laneForItem(item: WorkItem | null): Lane | null {
    if (!item) return null;
    return this.lanes().find(lane => lane.id === item.laneId) || null;
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

  private buildPausePatch(item: WorkItem, nowIso: string): Partial<WorkItem> {
    const resumedAt = (item.lastWorkResumedAt || '').trim() || (item.checkedInAt || '').trim();
    const increment = this.elapsedMs(resumedAt, nowIso);
    return {
      isPaused: true,
      pausedAt: nowIso,
      lastWorkResumedAt: '',
      workDurationMs: this.safeDuration(item.workDurationMs) + increment
    };
  }

  private buildResumePatch(item: WorkItem, nowIso: string): Partial<WorkItem> {
    const pausedAt = (item.pausedAt || '').trim();
    const increment = this.elapsedMs(pausedAt, nowIso);
    const patch: Partial<WorkItem> = {
      isPaused: false,
      pausedAt: '',
      lastWorkResumedAt: nowIso,
      pauseDurationMs: this.safeDuration(item.pauseDurationMs) + increment
    };
    if (!(item.checkedInAt || '').trim()) patch.checkedInAt = nowIso;
    return patch;
  }

  private buildCompletionTimingPatch(item: WorkItem, nowIso: string): Partial<WorkItem> {
    const isPaused = !!item.isPaused || !!(item.pausedAt || '').trim();
    const workIncrement = isPaused
      ? 0
      : this.elapsedMs((item.lastWorkResumedAt || '').trim() || (item.checkedInAt || '').trim(), nowIso);
    const pauseIncrement = isPaused ? this.elapsedMs(item.pausedAt, nowIso) : 0;

    return {
      isPaused: false,
      pausedAt: '',
      lastWorkResumedAt: '',
      workDurationMs: this.safeDuration(item.workDurationMs) + workIncrement,
      pauseDurationMs: this.safeDuration(item.pauseDurationMs) + pauseIncrement
    };
  }

  private resetWorkTimingPatch(): Partial<WorkItem> {
    return {
      isPaused: false,
      pausedAt: '',
      lastWorkResumedAt: '',
      workDurationMs: 0,
      pauseDurationMs: 0
    };
  }

  canCheckIn(it: WorkItem, lane: Lane): boolean {
    const customerId = (it.customerId || '').trim();
    if (!customerId) return false;
    if (this.laneStageKey(lane) !== 'scheduled') return false;
    if ((it.checkedInAt || '').trim()) return false;
    return true;
  }

  canRevertCheckIn(it: WorkItem, lane: Lane): boolean {
    if (!(it.checkedInAt || '').trim()) return false;
    if (!(this.isInProgressLane(lane) || this.isCompletedLane(lane))) return false;
    return !!this.scheduledLaneId();
  }

  needsCalendarOverride(it: WorkItem, lane: Lane): boolean {
    if (!this.isCompletedLane(lane)) return false;
    const customerId = (it.customerId || '').trim();
    if (!customerId) return false;
    if (this.hasCalendarEvent(customerId)) return false;
    return !(it.calendarOverrideAt || '').trim();
  }

  applyCalendarOverride(it: WorkItem, lane: Lane, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();

    if (!this.needsCalendarOverride(it, lane)) return;

    const nowIso = new Date().toISOString();
    const patch: Partial<WorkItem> & { id: string } = {
      id: it.id,
      calendarOverrideAt: nowIso
    };
    if (!(it.completedAt || '').trim()) patch.completedAt = nowIso;

    this.status.set('Applying calendar override');
    this.itemsApi.update(patch).subscribe({
      next: () => {
        this.items.update(current => {
          const next: Record<string, WorkItem[]> = {};
          for (const [laneId, rows] of Object.entries(current)) {
            next[laneId] = (rows || []).map(row => {
              if (row.id !== it.id) return row;
              return {
                ...row,
                calendarOverrideAt: nowIso,
                completedAt: (row.completedAt || '').trim() ? row.completedAt : nowIso
              };
            });
          }
          return next;
        });
        this.status.set('No appointment required set');
      },
      error: () => this.status.set('Calendar override failed')
    });
  }

  checkInCard(it: WorkItem, lane: Lane, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();

    const inProgressLaneId = this.inProgressLaneId();
    if (!inProgressLaneId) {
      this.status.set('Missing Work In-Progress lane.');
      return;
    }
    if (this.laneStageKey(lane) !== 'scheduled') return;
    if ((it.checkedInAt || '').trim()) {
      this.status.set('Already checked in.');
      return;
    }
    const customerId = (it.customerId || '').trim();
    if (customerId && !this.hasCalendarEvent(customerId)) {
      this.status.set('Calendar event required before check-in.');
      this.openScheduleModal(customerId);
      return;
    }

    const checkedInAt = new Date().toISOString();
    this.status.set('Checking in customer');
    this.itemsApi.update({
      id: it.id,
      laneId: inProgressLaneId,
      checkedInAt,
      completedAt: '',
      calendarOverrideAt: '',
      isPaused: false,
      pausedAt: '',
      lastWorkResumedAt: checkedInAt,
      workDurationMs: this.safeDuration(it.workDurationMs),
      pauseDurationMs: this.safeDuration(it.pauseDurationMs)
    }).subscribe({
      next: () => {
        this.items.update(current => {
          const next: Record<string, WorkItem[]> = {};
          for (const [laneId, rows] of Object.entries(current)) {
            next[laneId] = [...rows];
          }

          for (const laneId of Object.keys(next)) {
            next[laneId] = next[laneId].filter(row => row.id !== it.id);
          }

          const target = next[inProgressLaneId] || [];
          target.unshift({
            ...it,
            laneId: inProgressLaneId,
            checkedInAt,
            completedAt: '',
            calendarOverrideAt: '',
            isPaused: false,
            pausedAt: '',
            lastWorkResumedAt: checkedInAt,
            workDurationMs: this.safeDuration(it.workDurationMs),
            pauseDurationMs: this.safeDuration(it.pauseDurationMs)
          });
          next[inProgressLaneId] = target;
          return next;
        });
        this.status.set('Checked in');
      },
      error: () => this.status.set('Check-in failed')
    });
  }

  revertCheckInCard(it: WorkItem, lane: Lane, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();

    const scheduledId = this.scheduledLaneId();
    if (!scheduledId) {
      this.status.set('Missing Scheduled lane.');
      return;
    }
    if (!this.canRevertCheckIn(it, lane)) return;

    this.status.set('Reverting check-in');
    this.itemsApi.update({
      id: it.id,
      laneId: scheduledId,
      checkedInAt: '',
      completedAt: '',
      calendarOverrideAt: '',
      ...this.resetWorkTimingPatch()
    }).subscribe({
      next: () => {
        this.items.update(current => {
          const next: Record<string, WorkItem[]> = {};
          for (const [laneId, rows] of Object.entries(current)) {
            next[laneId] = [...rows].filter(row => row.id !== it.id);
          }
          const scheduled = next[scheduledId] || [];
          scheduled.unshift({
            ...it,
            laneId: scheduledId,
            checkedInAt: '',
            completedAt: '',
            calendarOverrideAt: '',
            ...this.resetWorkTimingPatch()
          });
          next[scheduledId] = scheduled;
          return next;
        });
        this.status.set('Moved back to Scheduled');
      },
      error: () => this.status.set('Revert check-in failed')
    });
  }

  openLaneMenu(ev: Event, lane: Lane) {
    this.laneMenuEvent.set(ev);
    this.laneMenuLaneId.set(lane.id);
    this.renameValue.set(lane.name || '');
    this.laneMenuOpen.set(true);
  }

  closeLaneMenu() {
    this.laneMenuOpen.set(false);
  }

  openDelete(lane: Lane) {
    this.deleteTargetId.set(lane.id);
    this.deleteTargetName.set(lane.name || '');
    this.deleteTargetCount.set(this.itemsCount(lane.id));
    this.deleteOpen.set(true);
  }

  cancelDelete() {
    this.deleteOpen.set(false);
  }

  handleDeleteFromMenu() {
    const id = this.laneMenuLaneId();
    if (!id) return;
    const lane = this.lanes().find(l => l.id === id);
    if (!lane) return;
    if (this.isProtectedLane(lane)) {
      this.status.set('Core workflow lanes cannot be deleted.');
      this.laneMenuOpen.set(false);
      return;
    }
    this.laneMenuOpen.set(false);
    setTimeout(() => this.openDelete(lane), 0);
  }

  openCardMenu(ev: Event, it: WorkItem) {
    this.cardMenuEvent.set(ev);
    this.cardMenuItemId.set(it.id);
    this.cardMenuOpen.set(true);
  }
  closeCardMenu() { this.cardMenuOpen.set(false); }

  startEditFromCard() {
    const itId = this.cardMenuItemId();
    this.cardMenuOpen.set(false);
    if (!itId) return;

    let it: WorkItem | undefined;
    for (const arr of Object.values(this.items())) {
      it = (arr as WorkItem[]).find(x => x.id === itId);
      if (it) break;
    }
    if (!it) return;

    const cust = this.customersMap()[it.customerId || ''];
    if (!cust) return;

    this.customerModalInitialNotes.set(this.notesOf(it) || null);

    this.customerModalMode.set('edit');
    this.customerModalId.set(cust.id);
    this.customerModalOpen.set(true);
  }

  private removeCardFromLaneById(itId: string) {
    if (!itId) return;
    this.status.set('Removing from lane');
    this.itemsApi.delete(itId).subscribe({
      next: () => {
        const map = { ...this.items() };
        for (const k of Object.keys(map)) map[k] = map[k].filter(w => w.id !== itId);
        this.items.set(map);
        this.status.set('Removed');
      },
      error: () => this.status.set('Remove error')
    });
  }

  cardRemoveLabel(): string {
    const item = this.findItemById(this.cardMenuItemId());
    const lane = this.laneForItem(item);
    if (this.isWorkflowStatusLane(lane)) return 'Remove customer';
    return 'Remove from lane';
  }

  removeCardAction() {
    const item = this.findItemById(this.cardMenuItemId());
    this.cardMenuOpen.set(false);
    if (!item) return;

    const lane = this.laneForItem(item);
    if (!this.isWorkflowStatusLane(lane)) {
      this.removeCardFromLaneById(item.id);
      return;
    }

    this.removeCustomerItemId.set(item.id);
    this.removeCustomerCustomerId.set((item.customerId || '').trim());
    this.removeCustomerOpen.set(true);
  }

  cancelRemoveCustomer() {
    this.removeCustomerOpen.set(false);
    this.removeCustomerItemId.set(null);
    this.removeCustomerCustomerId.set('');
  }

  confirmRemoveCustomer() {
    const itemId = this.removeCustomerItemId();
    const customerId = this.removeCustomerCustomerId();
    this.cancelRemoveCustomer();
    if (!itemId) return;

    this.status.set('Removing customer');

    const deleteWorkItem = () => {
      this.itemsApi.delete(itemId).subscribe({
        next: () => {
          this.status.set('Customer removed');
          this.loadAll();
        },
        error: () => this.status.set('Remove error')
      });
    };

    if (!customerId) {
      deleteWorkItem();
      return;
    }

    const now = Date.now();
    const scheduleIds = this.scheduleItems()
      .filter(entry => {
        if ((entry.customerId || '').trim() !== customerId) return false;
        if (!entry.start) return false;
        const startMs = Date.parse(entry.start);
        return Number.isFinite(startMs) && startMs >= now;
      })
      .map(entry => entry.id)
      .filter(Boolean);

    if (!scheduleIds.length) {
      deleteWorkItem();
      return;
    }

    const deletes = scheduleIds.map(id =>
      this.scheduleApi.delete(id).pipe(catchError(() => of({ ok: false })))
    );
    forkJoin(deletes).subscribe({
      next: () => deleteWorkItem(),
      error: () => deleteWorkItem()
    });
  }

  confirmDelete() {
    const id = this.deleteTargetId();
    const cnt = this.deleteTargetCount();
    if (!id) { this.deleteOpen.set(false); return; }
    if (this.isProtectedLaneById(id)) {
      this.deleteOpen.set(false);
      this.status.set('Core workflow lanes cannot be deleted.');
      return;
    }
    if (cnt > 0) { this.status.set('Lane not empty'); this.deleteOpen.set(false); return; }
    this.status.set('Deleting lane');
    this.lanesApi.delete(id).subscribe({
      next: () => { this.deleteOpen.set(false); this.loadAll(); this.status.set('Deleted'); },
      error: () => { this.deleteOpen.set(false); this.status.set('Delete lane error'); }
    });
  }

  itemsCount(laneId: string): number {
    const arr = this.items()[laneId] || [];
    return arr.length;
  }

  deleteLane(laneId: string) {
    const count = this.itemsCount(laneId);
    if (this.isProtectedLaneById(laneId)) {
      this.status.set('Core workflow lanes cannot be deleted.');
      return;
    }
    if (count > 0) { this.status.set('Lane not empty'); return; }
    if (!window.confirm('Delete lane?')) return;
    this.status.set('Deleting lane');
    this.lanesApi.delete(laneId).subscribe({
      next: () => { this.loadAll(); this.status.set('Deleted'); },
      error: () => this.status.set('Delete lane error')
    });
  }

  deleteMenuLane() {
    const id = this.laneMenuLaneId();
    if (!id) return;
    this.deleteLane(id);
    this.laneMenuOpen.set(false);
  }

  startRename() {
    this.renameOpen.set(true);
    this.laneMenuOpen.set(false);
  }

  canSaveRename(): boolean {
    const id = this.laneMenuLaneId();
    if (!id) return false;
    const nextName = this.renameValue().trim();
    if (!nextName) return false;
    const lane = this.lanes().find(l => l.id === id);
    const currentName = (lane?.name || '').trim();
    return nextName !== currentName;
  }

  saveRename() {
    const id = this.laneMenuLaneId();
    const nm = this.renameValue().trim();
    if (!this.canSaveRename() || !id || !nm) { return; }
    if (this.isProtectedLaneById(id)) {
      this.renameOpen.set(false);
      this.status.set('Core workflow lanes cannot be renamed.');
      return;
    }
    this.status.set('Renaming lane');
    this.lanesApi.update(id, nm).subscribe({
      next: () => { this.renameOpen.set(false); this.loadAll(); this.status.set('Renamed'); },
      error: () => { this.renameOpen.set(false); this.status.set('Rename error'); }
    });
  }

  loadLaneColors() {
    this.laneColorsLoaded = false;
    const token = ++this.laneColorsLoadToken;
    this.userSettings.getValue<Record<string, string>>(LANE_COLORS_SETTING_KEY).subscribe(value => {
      if (token !== this.laneColorsLoadToken) return;
      this.laneColors.set(this.normalizeLaneColors(value));
      this.laneColorsLoaded = true;
    });
  }

  private normalizeLaneColors(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object') return {};
    const input = value as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [laneKey, color] of Object.entries(input)) {
      const key = String(laneKey || '').trim();
      const hex = String(color || '').trim();
      if (!key || !hex) continue;
      out[key] = hex;
    }
    return out;
  }

  private normalizeLaneName(name: string | null | undefined): string {
    const value = String(name || '').trim().toLowerCase();
    if (!value) return '';
    return value.replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '');
  }

  private laneColorStableKey(lane: Lane): string {
    const explicitStage = String(lane.stageKey || '').trim().toLowerCase();
    if (explicitStage) return `stage:${explicitStage === 'quote' ? 'lead' : explicitStage}`;
    const inferredStage = this.laneStageKey(lane);
    if (inferredStage && inferredStage !== 'custom') return `stage:${inferredStage}`;
    const normalizedName = this.normalizeLaneName(lane.name);
    return normalizedName ? `name:${normalizedName}` : `id:${lane.id}`;
  }

  private laneColorLookupKeys(target: Lane | string): string[] {
    if (typeof target === 'string') {
      const id = target.trim();
      return id ? [`id:${id}`, id] : [];
    }
    const id = String(target.id || '').trim();
    const stable = this.laneColorStableKey(target);
    const legacyName = this.normalizeLaneName(target.name);
    const keys = [id ? `id:${id}` : '', stable, id, legacyName];
    return keys.filter((value, index, list) => value && list.indexOf(value) === index);
  }

  private laneColorPersistKeys(target: Lane | string): string[] {
    if (typeof target === 'string') return this.laneColorLookupKeys(target);
    const id = String(target.id || '').trim();
    const stable = this.laneColorStableKey(target);
    const keys = [id ? `id:${id}` : '', stable, id];
    return keys.filter((value, index, list) => value && list.indexOf(value) === index);
  }

  laneColor(target: Lane | string): string {
    const map = this.laneColors();
    for (const key of this.laneColorLookupKeys(target)) {
      const value = map[key];
      if (value) return value;
    }
    return '';
  }

  setLaneColor(target: Lane | string, color: string) {
    const keys = this.laneColorPersistKeys(target);
    if (!keys.length) return;
    const m = { ...this.laneColors() };
    if (!color) {
      for (const key of keys) delete m[key];
    } else {
      for (const key of keys) m[key] = color;
    }
    this.laneColors.set(m);
  }

  loadAll() {
    this.loading.set(true);
    this.customersApi.list().subscribe({
      next: cs => {
        const m: Record<string, Customer> = {};
        for (const c of cs) m[c.id] = c;
        this.customersMap.set(m);
        this.allCustomers.set(cs);
        this.scheduleApi.list().subscribe({
          next: sched => {
            this.scheduleItems.set(sched || []);
            this.lanesApi.list().subscribe({
              next: lanes => {
                this.lanes.set(lanes);
                this.itemsApi.list().subscribe({
                  next: rows => {
                    const map: Record<string, WorkItem[]> = {};
                    for (const l of lanes) map[l.id] = [];
                    for (const r of rows) {
                      if (!map[r.laneId]) map[r.laneId] = [];
                      map[r.laneId].push({ ...r, customerId: r.customerId ?? '' });
                    }
                    for (const id of Object.keys(map)) map[id].sort((a,b) => (a.sort ?? 0) - (b.sort ?? 0));
                    this.items.set(map);
                    this.pruneExpiredCompletedFromBoard();
                    this.syncScheduledLane();
                    this.loading.set(false);
                  },
                  error: () => { this.status.set('Load items error'); this.loading.set(false); }
                });
              },
              error: () => { this.status.set('Load lanes error'); this.loading.set(false); }
            });
          },
          error: () => {
            this.scheduleItems.set([]);
            this.lanesApi.list().subscribe({
              next: lanes => {
                this.lanes.set(lanes);
                this.itemsApi.list().subscribe({
                  next: rows => {
                    const map: Record<string, WorkItem[]> = {};
                    for (const l of lanes) map[l.id] = [];
                    for (const r of rows) {
                      if (!map[r.laneId]) map[r.laneId] = [];
                      map[r.laneId].push({ ...r, customerId: r.customerId ?? '' });
                    }
                    for (const id of Object.keys(map)) map[id].sort((a,b) => (a.sort ?? 0) - (b.sort ?? 0));
                    this.items.set(map);
                    this.pruneExpiredCompletedFromBoard();
                    this.loading.set(false);
                  },
                  error: () => { this.status.set('Load items error'); this.loading.set(false); }
                });
              },
              error: () => { this.status.set('Load lanes error'); this.loading.set(false); }
            });
          }
        });
      },
      error: () => { this.status.set('Load customers error'); this.loading.set(false); }
    });
  }

  recentCustomers = computed(() => {
    const arr = this.allCustomers().slice();
    arr.sort((a: any, b: any) => {
      const ta = Date.parse(a?.createdAt || '');
      const tb = Date.parse(b?.createdAt || '');
      if (Number.isFinite(tb) && Number.isFinite(ta)) return tb - ta;
      if (Number.isFinite(tb)) return 1;
      if (Number.isFinite(ta)) return -1;
      return 0;
    });
    return arr.slice(0, 10);
  });

  customerName(it: WorkItem): string {
    const c = this.customersMap()[it.customerId ?? ''];
    const n = (c?.name || '').trim();
    if (n) return n;
    const t = (it.title || '').replace(/\[c=[^\]]+\]/gi, '').trim();
    const dashIdx = t.indexOf('—');
    const head = dashIdx >= 0 ? t.slice(0, dashIdx).trim() : t;
    const parenIdx = head.indexOf('(');
    const name = (parenIdx >= 0 ? head.slice(0, parenIdx) : head).trim();
    return name || 'No customer';
  }

  hasUnreadActivity(it: WorkItem): boolean {
    return this.unreadSmsCount(it) > 0 || this.unreadEmailCount(it) > 0;
  }

  unreadSmsCount(it: WorkItem): number {
    const customerId = (it.customerId || '').trim();
    if (!customerId) return 0;
    return this.unreadActivityByCustomer()[customerId] || 0;
  }

  unreadEmailCount(it: WorkItem): number {
    const customerId = (it.customerId || '').trim();
    if (!customerId) return 0;
    return this.unreadEmailByCustomer()[customerId] || 0;
  }

  hasUnreadSms(it: WorkItem): boolean {
    return this.unreadSmsCount(it) > 0;
  }

  hasUnreadEmail(it: WorkItem): boolean {
    return this.unreadEmailCount(it) > 0;
  }

  isCheckedIn(it: WorkItem): boolean {
    return !!(it.checkedInAt || '').trim();
  }

  unreadActivityTitle(it: WorkItem): string {
    const smsCount = this.unreadSmsCount(it);
    const emailCount = this.unreadEmailCount(it);
    const parts: string[] = [];
    if (smsCount) parts.push(`${smsCount} unread sms ${smsCount === 1 ? 'message' : 'messages'}`);
    if (emailCount) parts.push(`${emailCount} unread email ${emailCount === 1 ? 'message' : 'messages'}`);
    return parts.join(' • ');
  }

  openCustomerProfileFromCard(it: WorkItem, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    const customerId = (it.customerId || '').trim();
    if (!customerId) return;
    this.router.navigate(['/customers', customerId]);
  }

  openCustomerActivity(it: WorkItem, activity: 'sms' | 'email', event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    const customerId = (it.customerId || '').trim();
    if (!customerId) return;
    if (activity === 'sms') {
      const unreadIds = this.unreadSmsIdsByCustomer()[customerId] || [];
      this.unreadActivityByCustomer.update(current => {
        if (!current[customerId]) return current;
        const next = { ...current };
        delete next[customerId];
        return next;
      });
      this.unreadSmsIdsByCustomer.update(current => {
        if (!current[customerId]) return current;
        const next = { ...current };
        delete next[customerId];
        return next;
      });
      if (unreadIds.length) {
        this.smsApi.markReadBatch(unreadIds).subscribe({
          error: () => this.refreshUnreadActivity()
        });
      }
    } else {
      const unreadIds = this.unreadEmailIdsByCustomer()[customerId] || [];
      this.unreadEmailByCustomer.update(current => {
        if (!current[customerId]) return current;
        const next = { ...current };
        delete next[customerId];
        return next;
      });
      this.unreadEmailIdsByCustomer.update(current => {
        if (!current[customerId]) return current;
        const next = { ...current };
        delete next[customerId];
        return next;
      });
      if (unreadIds.length) {
        this.emailApi.markReadBatch(unreadIds).subscribe({
          error: () => this.refreshUnreadActivity()
        });
      }
    }
    this.router.navigate(['/customers', customerId], {
      queryParams: { tab: activity === 'sms' ? 'sms' : 'email' }
    });
  }

  customerContact(it: WorkItem): string {
    const c = this.customersMap()[it.customerId ?? ''];
    return c?.phone || c?.email || '';
  }

  isLeadLane(lane: Lane): boolean {
    return this.laneStageKey(lane) === 'lead';
  }

  leadReceivedLabel(it: WorkItem): string {
    const fallback = this.customersMap()[it.customerId ?? '']?.createdAt || '';
    const raw = (it.createdAt || fallback || '').trim();
    if (!raw) return '';
    try {
      return new Date(raw).toLocaleString();
    } catch {
      return raw;
    }
  }

  vehicleOf(it: WorkItem): string {
    const cust = this.customersMap()[it.customerId ?? ''] as any;
    const parts = [cust?.vehicleYear, cust?.vehicleMake, cust?.vehicleModel]
      .filter(Boolean)
      .map((s: string) => s.toString().trim())
      .filter(Boolean);
    if (parts.length) return parts.join(' ');

    const m = (it.title || '').match(/\(([^)]+)\)/);
    return m?.[1] ?? '';
  }

  colorOf(it: WorkItem): string {
    const cust = this.customersMap()[it.customerId ?? ''] as any;
    const col = (cust?.vehicleColor || '').toString().trim();
    if (col) return col;

    const m = (it.title || '').match(/\[c=([^\]]+)\]/);
    return m?.[1] ?? '';
  }

  notesOf(it: WorkItem): string {
    const cust = this.customersMap()[it.customerId ?? ''] as any;
    const n = (cust?.notes || '').toString().trim();
    if (n) return n;

    const title = it.title || '';
    const idx = title.indexOf('— ');
    if (idx < 0) return '';
    let note = title.slice(idx + 2);
    note = note.replace(/\[c=[^\]]+\]/gi, '').trim().replace(/\s{2,}/g, ' ');
    return note;
  }

  appointmentLabel(it: WorkItem): string {
    const customerId = it.customerId ?? '';
    if (!customerId) return '';
    const list = this.scheduleItems().filter(s => s.customerId === customerId && !s.isBlocked && s.start && s.end);
    if (!list.length) return '';
    const now = Date.now();
    const upcoming = list.filter(s => Date.parse(s.start) >= now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const chosen = (upcoming.length ? upcoming[0] : list.sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0]);
    if (!chosen) return '';
    try {
      const start = new Date(chosen.start);
      const end = new Date(chosen.end);
      const startLine = start.toLocaleString();
      const endLine = end.toLocaleString();
      return `${startLine}<br/>${endLine}`;
    } catch {
      return '';
    }
  }

  private scheduledLaneId(): string | null {
    const lane = this.lanes().find(l => this.laneStageKey(l) === 'scheduled');
    return lane?.id || null;
  }

  private leadLaneId(): string | null {
    const lane = this.lanes().find(l => this.laneStageKey(l) === 'lead');
    return lane?.id || null;
  }

  private hasFutureSchedule(customerId: string, nowMs: number = Date.now()): boolean {
    if (!customerId) return false;
    return this.scheduleItems().some(s => {
      if ((s.customerId || '').trim() !== customerId) return false;
      if (s.isBlocked || !s.start || !s.end) return false;
      const startMs = Date.parse(s.start);
      return Number.isFinite(startMs) && startMs >= nowMs;
    });
  }

  private hasCalendarEvent(customerId: string): boolean {
    if (!customerId) return false;
    return this.scheduleItems().some(s => {
      if ((s.customerId || '').trim() !== customerId) return false;
      return !s.isBlocked && !!s.start && !!s.end;
    });
  }

  private futureScheduleCustomerIds(nowMs: number = Date.now()): Set<string> {
    const ids = new Set<string>();
    for (const item of this.scheduleItems()) {
      const customerId = (item.customerId || '').trim();
      if (!customerId || item.isBlocked || !item.start || !item.end) continue;
      const startMs = Date.parse(item.start);
      if (!Number.isFinite(startMs) || startMs < nowMs) continue;
      ids.add(customerId);
    }
    return ids;
  }

  private cardTitleForCustomer(customerId: string): string {
    const customer = this.customersMap()[customerId];
    if (!customer) return 'Scheduled customer';
    const displayName =
      (customer.name || '').trim() ||
      `${customer.firstName || ''} ${customer.lastName || ''}`.trim() ||
      'Scheduled customer';
    const vehicle = this.customerVehicleBasic(customer);
    return vehicle ? `${displayName} (${vehicle})` : displayName;
  }

  private ensureScheduledCardsForCustomers(customerIds: string[], scheduledLaneId: string): void {
    const pending = [...new Set(customerIds.map(id => id.trim()).filter(Boolean))];
    if (!pending.length) return;

    let index = 0;
    const createNext = () => {
      if (index >= pending.length) {
        this.loadAll();
        return;
      }
      const customerId = pending[index++];
      const title = this.cardTitleForCustomer(customerId);
      this.itemsApi.create(title, scheduledLaneId).subscribe({
        next: created => {
          this.itemsApi.update({ id: created.id, customerId }).subscribe({
            next: () => createNext(),
            error: () => createNext()
          });
        },
        error: () => createNext()
      });
    };

    createNext();
  }

  private syncScheduledLane() {
    const scheduledId = this.scheduledLaneId();
    if (!scheduledId) return;
    const leadId = this.leadLaneId();
    const inProgressId = this.inProgressLaneId();
    const nowMs = Date.now();
    const futureCustomerIds = this.futureScheduleCustomerIds(nowMs);
    const map: Record<string, WorkItem[]> = {};
    for (const [laneId, rows] of Object.entries(this.items())) {
      map[laneId] = [...rows];
    }

    const movedToScheduled: WorkItem[] = [];
    const movedOutOfScheduled: Array<{ item: WorkItem; targetLaneId: string }> = [];
    for (const laneId of Object.keys(map)) {
      if (this.isInProgressLaneById(laneId) || this.isCompletedLaneById(laneId)) continue;
      const keep: WorkItem[] = [];
      for (const it of map[laneId] || []) {
        const alreadyCheckedIn = !!(it.checkedInAt || '').trim();
        const customerId = (it.customerId || '').trim();
        const hasFutureSchedule = customerId ? futureCustomerIds.has(customerId) : false;

        if (laneId !== scheduledId) {
          if (customerId && hasFutureSchedule && !alreadyCheckedIn) {
            movedToScheduled.push({ ...it, laneId: scheduledId });
            continue;
          }
          keep.push(it);
          continue;
        }

        // Scheduled lane should only contain customers with future appointments.
        if (!customerId || (hasFutureSchedule && !alreadyCheckedIn)) {
          keep.push(it);
          continue;
        }

        const fallbackLaneId =
          alreadyCheckedIn && inProgressId && inProgressId !== scheduledId
            ? inProgressId
            : (leadId && leadId !== scheduledId ? leadId : '');
        if (fallbackLaneId) {
          movedOutOfScheduled.push({ item: { ...it, laneId: fallbackLaneId }, targetLaneId: fallbackLaneId });
          continue;
        }

        keep.push(it);
      }
      map[laneId] = keep;
    }

    if (movedToScheduled.length) {
      map[scheduledId] = [...(map[scheduledId] || []), ...movedToScheduled];
    }
    for (const move of movedOutOfScheduled) {
      map[move.targetLaneId] = [...(map[move.targetLaneId] || []), move.item];
    }

    if (movedToScheduled.length || movedOutOfScheduled.length) {
      this.items.set(map);
      for (const it of movedToScheduled) {
        this.itemsApi.update({ id: it.id, laneId: scheduledId }).subscribe();
      }
      for (const move of movedOutOfScheduled) {
        this.itemsApi.update({ id: move.item.id, laneId: move.targetLaneId }).subscribe();
      }
    }

    const scheduledCustomers = new Set(
      (map[scheduledId] || [])
        .map(item => (item.customerId || '').trim())
        .filter(Boolean)
    );
    const missingScheduledCards = [...futureCustomerIds].filter(customerId => !scheduledCustomers.has(customerId));
    if (missingScheduledCards.length) {
      this.ensureScheduledCardsForCustomers(missingScheduledCards, scheduledId);
    }
  }

  private pruneExpiredCompletedFromBoard(): void {
    const allLanes = this.lanes();
    if (!allLanes.length) return;
    const completedLaneIds = new Set(
      allLanes.filter(lane => this.isCompletedLane(lane)).map(lane => lane.id)
    );
    if (!completedLaneIds.size) return;

    const todayKey = this.localDayKey(new Date());
    if (!todayKey) return;

    const current = this.items();
    let changed = false;
    const next: Record<string, WorkItem[]> = {};

    for (const [laneId, rows] of Object.entries(current)) {
      if (!completedLaneIds.has(laneId)) {
        next[laneId] = rows;
        continue;
      }
      const filtered = (rows || []).filter(item => !this.isCompletedFromPreviousDay(item, todayKey));
      if (filtered.length !== (rows || []).length) changed = true;
      next[laneId] = filtered;
    }

    if (changed) this.items.set(next);
  }

  private isCompletedFromPreviousDay(it: WorkItem, todayKey: string = this.localDayKey(new Date())): boolean {
    const completedAt = (it.completedAt || '').trim();
    if (!completedAt || !todayKey) return false;
    const completedDay = this.localDayKey(completedAt);
    if (!completedDay) return false;
    return completedDay < todayKey;
  }

  private localDayKey(value: string | Date): string {
    const date = value instanceof Date ? value : new Date(String(value || ''));
    if (!Number.isFinite(date.getTime())) return '';
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  openScheduleModal(customerId: string) {
    this.scheduleModalCustomerId.set(customerId);
    this.scheduleModalOpen.set(true);
  }

  closeScheduleModal() {
    this.scheduleModalOpen.set(false);
    this.scheduleModalCustomerId.set(null);
  }

  onScheduleSaved() {
    this.closeScheduleModal();
    this.loadAll();
  }


  isExpanded(id: string): boolean {
    return !!this.expanded()[id];
  }

  toggleExpanded(id: string) {
    const e = { ...this.expanded() };
    e[id] = !e[id];
    this.expanded.set(e);
  }

  openSearch(laneId: string) {
    this.searchLaneId.set(laneId);
    this.searchTerm.set('');
    this.searchOpen.set(true);
  }

  closeSearch() {
    this.searchOpen.set(false);
    this.searchLaneId.set(null);
    this.searchTerm.set('');
  }

  laneNameById(id: string | null): string {
    if (!id) return '';
    return this.lanes().find(l => l.id === id)?.name || '';
  }

  customerVehicleBasic(c: Customer): string {
    const e = c as any;
    const parts: string[] = [];
    if (e['vehicleYear']) parts.push(String(e['vehicleYear']));
    if (e['vehicleMake']) parts.push(String(e['vehicleMake']));
    if (e['vehicleModel']) parts.push(String(e['vehicleModel']));
    return parts.join(' ');
  }

  addExistingToLane(c: Customer) {
    const laneId = this.searchLaneId();
    if (!laneId) return;
    const isCompletedLane = this.isCompletedLaneById(laneId);
    const hasCalendar = this.hasCalendarEvent(c.id);
    if (this.isScheduleRequiredLaneById(laneId) && !hasCalendar && !isCompletedLane) {
      this.status.set('Calendar event required before moving to this lane.');
      this.closeSearch();
      this.openScheduleModal(c.id);
      return;
    }
    const scheduledId = this.scheduledLaneId();
    const isScheduledLane = !!scheduledId && laneId === scheduledId;
    const baseName = (c.name || 'Unnamed').trim();
    const veh = this.customerVehicleBasic(c);
    const title = veh ? `${baseName} (${veh})` : baseName;
    this.status.set('Creating card');
    this.itemsApi.create(title, laneId).subscribe({
      next: created => {
        this.itemsApi.update({ id: created.id, customerId: c.id }).subscribe({
          next: () => {
            this.closeSearch();
            this.loadAll();
            if (isCompletedLane && !hasCalendar) {
              this.status.set('Added to Completed. Click "No appointment required" to confirm override.');
            } else {
              this.status.set('Added to lane');
            }
            if (isScheduledLane) {
              this.openScheduleModal(c.id);
            }
          }
        });
      },
      error: () => { this.status.set('Create card error'); }
    });
  }

  openAddCustomerForLane() {
    const laneId = this.searchLaneId();
    if (!laneId) return;
    this.closeSearch();
    this.customerModalMode.set('add');
    this.customerModalId.set(null);
    this.laneToLinkAfterSave.set(laneId);
    this.customerModalOpen.set(true);
  }

  onCustomerModalClosed() {
    this.customerModalOpen.set(false);
    this.customerModalId.set(null);
    this.customerModalMode.set('add');
    this.laneToLinkAfterSave.set(null);
    this.customerModalInitialNotes.set(null);
  }

  onCustomerSaved(evt: any) {
    const laneId = this.laneToLinkAfterSave();
    this.customerModalOpen.set(false);
    if (!laneId) { this.status.set('Saved'); this.loadAll(); return; }
    this.status.set('Saving');
    this.customersApi.list().subscribe({
      next: cs => {
        this.allCustomers.set(cs);
        const id = (evt && (evt.id || evt.customerId || evt)) as string;
        const cust = cs.find(x => x.id === id) || null;
        if (!cust) { this.status.set('Saved'); this.loadAll(); return; }
        const baseName = (cust.name || 'Unnamed').trim();
        const veh = this.customerVehicleBasic(cust);
        const title = veh ? `${baseName} (${veh})` : baseName;
        const isCompletedLane = this.isCompletedLaneById(laneId);
        const hasCalendar = this.hasCalendarEvent(cust.id);
        if (this.isScheduleRequiredLaneById(laneId) && !hasCalendar && !isCompletedLane) {
          this.status.set('Calendar event required before moving to this lane.');
          this.openScheduleModal(cust.id);
          return;
        }
        const scheduledId = this.scheduledLaneId();
        const isScheduledLane = !!scheduledId && laneId === scheduledId;
        this.itemsApi.create(title, laneId).subscribe({
          next: created => {
            this.itemsApi.update({ id: created.id, customerId: cust.id }).subscribe({
              next: () => {
                this.laneToLinkAfterSave.set(null);
                if (isCompletedLane && !hasCalendar) {
                  this.status.set('Added to Completed. Click "No appointment required" to confirm override.');
                } else {
                  this.status.set('Added to lane');
                }
                this.loadAll();
                if (isScheduledLane) {
                  this.openScheduleModal(cust.id);
                }
              }
            });
          },
          error: () => { this.status.set('Create card error'); }
        });
      },
      error: () => { this.status.set('Saved'); this.loadAll(); }
    });
  }

  addLane() {
    const name = this.newLane().trim();
    if (!name) return;
    this.status.set('Saving lane');
    this.lanesApi.create(name).subscribe({
      next: () => { this.newLane.set(''); this.loadAll(); this.status.set('Added lane'); },
      error: () => this.status.set('Save lane error')
    });
  }

  onLanesDrop(e: CdkDragDrop<Lane[]>) {
    const arr = [...this.lanes()];
    moveItemInArray(arr, e.previousIndex, e.currentIndex);
    this.lanes.set(arr);
    const ids = arr.map(x => x.id);
    this.lanesApi.reorder(ids).subscribe();
  }

  private compareCreatedDesc(a: WorkItem, b: WorkItem): number {
    const ta = a.createdAt ? Date.parse(a.createdAt) : NaN;
    const tb = b.createdAt ? Date.parse(b.createdAt) : NaN;
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    if (Number.isFinite(tb)) return 1;
    if (Number.isFinite(ta)) return -1;
    const sa = (a as any).sort ?? 0;
    const sb = (b as any).sort ?? 0;
    return sb - sa;
  }

  getLaneCards(laneId: string): WorkItem[] {
    const base = this.items()[laneId] || [];
    const arr = [...base];
    arr.sort((a, b) => this.compareCreatedDesc(a, b));
    return arr;
  }

  laneItemCount(laneId: string): number {
    return (this.items()[laneId] || []).length;
  }

  onCardsDrop(event: CdkDragDrop<WorkItem[]>, targetLaneId: string) {
    const map = { ...this.items() };
    const sourceId = event.previousContainer.id;
    const targetId = event.container.id;
    if (sourceId === targetId) {
      map[targetId] = [...map[targetId]].sort((a, b) => this.compareCreatedDesc(a, b));
      this.items.set(map);
      return;
    } else {
      const moved = map[sourceId][event.previousIndex];
      const toCompleted = this.isCompletedLaneById(targetLaneId);
      const movedCustomerId = (moved?.customerId || '').trim();
      if (movedCustomerId && this.isScheduleRequiredLaneById(targetLaneId) && !this.hasCalendarEvent(movedCustomerId)) {
        if (!toCompleted) {
          this.status.set('Calendar event required before moving to this lane.');
          this.openScheduleModal(movedCustomerId);
          return;
        }
      }
      const scheduledId = this.scheduledLaneId();
      if (scheduledId && targetLaneId === scheduledId && moved?.customerId && !this.hasFutureSchedule(moved.customerId)) {
        this.status.set('Scheduled lane requires a future appointment.');
        this.openScheduleModal(moved.customerId);
        return;
      }

      transferArrayItem(map[sourceId], map[targetId], event.previousIndex, event.currentIndex);
      this.items.set(map);
      const updated = map[targetId][event.currentIndex];
      const fromInProgress = this.isInProgressLaneById(sourceId);
      const toInProgress = this.isInProgressLaneById(targetLaneId);
      const hasCheckIn = !!(updated.checkedInAt || '').trim();
      const needsAutoCheckIn = toInProgress && !hasCheckIn;
      const needsResume = toInProgress && hasCheckIn &&
        (!!updated.isPaused || !!(updated.pausedAt || '').trim() || !(updated.lastWorkResumedAt || '').trim());
      const needsPause = fromInProgress && !toInProgress && !toCompleted && hasCheckIn && !updated.isPaused;
      const needsCompletionTiming = toCompleted && hasCheckIn;
      const autoCheckInAt = needsAutoCheckIn ? new Date().toISOString() : '';
      const nowIso = new Date().toISOString();
      const needsCalendarOverride = !!(movedCustomerId && toCompleted && !this.hasCalendarEvent(movedCustomerId));
      if (needsAutoCheckIn) {
        Object.assign(updated, {
          checkedInAt: autoCheckInAt,
          completedAt: '',
          calendarOverrideAt: '',
          isPaused: false,
          pausedAt: '',
          lastWorkResumedAt: autoCheckInAt,
          workDurationMs: this.safeDuration(updated.workDurationMs),
          pauseDurationMs: this.safeDuration(updated.pauseDurationMs)
        });
      }
      const updateBody: Partial<WorkItem> & { id: string } = { id: updated.id, laneId: targetLaneId };
      if (needsAutoCheckIn) {
        updateBody.checkedInAt = autoCheckInAt;
        updateBody.completedAt = '';
        updateBody.calendarOverrideAt = '';
        updateBody.isPaused = false;
        updateBody.pausedAt = '';
        updateBody.lastWorkResumedAt = autoCheckInAt;
        updateBody.workDurationMs = this.safeDuration(updated.workDurationMs);
        updateBody.pauseDurationMs = this.safeDuration(updated.pauseDurationMs);
      } else if (needsResume) {
        const patch = this.buildResumePatch(updated, nowIso);
        Object.assign(updated, patch);
        Object.assign(updateBody, patch);
      } else if (needsPause) {
        const patch = this.buildPausePatch(updated, nowIso);
        Object.assign(updated, patch);
        Object.assign(updateBody, patch);
      }
      if (toCompleted) {
        updateBody.completedAt = nowIso;
        updated.completedAt = nowIso;
        if (needsCompletionTiming) {
          const patch = this.buildCompletionTimingPatch(updated, nowIso);
          Object.assign(updated, patch);
          Object.assign(updateBody, patch);
        }
        if (needsCalendarOverride) {
          updateBody.calendarOverrideAt = '';
          updated.calendarOverrideAt = '';
        }
      } else {
        updateBody.completedAt = '';
        updateBody.calendarOverrideAt = '';
        updated.completedAt = '';
        updated.calendarOverrideAt = '';
      }
      this.itemsApi.update(updateBody).subscribe({
        next: () => {
          map[targetId] = [...map[targetId]].sort((a, b) => this.compareCreatedDesc(a, b));
          map[sourceId] = [...map[sourceId]].sort((a, b) => this.compareCreatedDesc(a, b));
          this.items.set(map);
          if (needsCalendarOverride) {
            this.status.set('Moved to Completed. Click "No appointment required" to confirm override.');
          }
          if (scheduledId && targetLaneId === scheduledId && updated.customerId) {
            this.openScheduleModal(updated.customerId);
          }
        }
      });
    }
  }

  createdAtLabel(it: WorkItem): string {
    if (!it.createdAt) return '';
    try { return new Date(it.createdAt).toLocaleString(); } catch { return String(it.createdAt); }
  }

  trackLane(_i: number, l: Lane) { return l.id; }
  trackItem(_i: number, it: WorkItem) { return it.id; }
}
