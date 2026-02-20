import { Component, signal, computed, effect, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import {
  IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton,
  IonItem, IonLabel, IonInput, IonSpinner, IonIcon, IonModal,
  IonList, IonPopover, IonSelect, IonSelectOption, IonToggle
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
import { ThemeService } from '../../services/theme.service';
import { UserScopedSettingsService } from '../../services/user-scoped-settings.service';

type ColorOpt = { label: string; hex: string };
const LANE_COLORS_SETTING_KEY = 'dashboard.laneColors';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton,
    IonItem, IonLabel, IonInput, IonSpinner, IonIcon, IonModal,
    IonList, IonPopover, IonSelect, IonSelectOption, IonToggle,
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
  isMobileLayout = signal(false);
  readonly isDarkTheme = computed(() => this.theme.mode() === 'dark');

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
    private theme: ThemeService,
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
        for (const item of items) {
          const customerId = (item.customerId || '').trim();
          if (!customerId) continue;
          map[customerId] = (map[customerId] || 0) + 1;
        }
        this.unreadActivityByCustomer.set(map);
      }
    });

    this.emailApi.listInbox().subscribe({
      next: res => {
        const items = Array.isArray(res.items) ? res.items : [];
        const map: Record<string, number> = {};
        for (const item of items) {
          const customerId = (item.customerId || '').trim();
          if (!customerId) continue;
          map[customerId] = (map[customerId] || 0) + 1;
        }
        this.unreadEmailByCustomer.set(map);
      }
    });
  }

  openSettings() {
    this.settingsOpen.set(true);
  }

  onThemeToggle(checked: boolean): void {
    this.theme.setMode(checked ? 'dark' : 'light');
  }

  laneStageKey(lane: Lane | null | undefined): string {
    const explicit = (lane?.stageKey || '').trim().toLowerCase();
    if (explicit) return explicit;
    const name = (lane?.name || '').trim().toLowerCase();
    if (!name) return 'custom';
    if (/lead/.test(name)) return 'lead';
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

  private inProgressLaneId(): string | null {
    const lane = this.lanes().find(item => this.isInProgressLane(item));
    return lane?.id || null;
  }

  canCheckIn(it: WorkItem, lane: Lane): boolean {
    const customerId = (it.customerId || '').trim();
    if (!customerId) return false;
    if (this.isCompletedLane(lane) || this.isInProgressLane(lane)) return false;
    if ((it.checkedInAt || '').trim()) return false;
    return true;
  }

  checkInCard(it: WorkItem, lane: Lane, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();

    const inProgressLaneId = this.inProgressLaneId();
    if (!inProgressLaneId) {
      this.status.set('Missing Work In-Progress lane.');
      return;
    }
    if (this.isCompletedLane(lane) || this.isInProgressLane(lane)) return;
    if ((it.checkedInAt || '').trim()) {
      this.status.set('Already checked in.');
      return;
    }

    const checkedInAt = new Date().toISOString();
    this.status.set('Checking in customer');
    this.itemsApi.update({ id: it.id, laneId: inProgressLaneId, checkedInAt }).subscribe({
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
            completedAt: ''
          });
          next[inProgressLaneId] = target;
          return next;
        });
        this.status.set('Checked in');
      },
      error: () => this.status.set('Check-in failed')
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

  removeCardFromLane() {
    const itId = this.cardMenuItemId();
    this.cardMenuOpen.set(false);
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

  saveRename() {
    const id = this.laneMenuLaneId();
    const nm = this.renameValue().trim();
    if (!id || !nm) { this.renameOpen.set(false); return; }
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
    for (const [laneId, color] of Object.entries(input)) {
      const id = String(laneId || '').trim();
      const hex = String(color || '').trim();
      if (!id || !hex) continue;
      out[id] = hex;
    }
    return out;
  }

  laneColor(laneId: string): string {
    return this.laneColors()[laneId] || '';
  }

  setLaneColor(laneId: string, color: string) {
    const m = { ...this.laneColors() };
    if (!color) delete m[laneId]; else m[laneId] = color;
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
      this.unreadActivityByCustomer.update(current => {
        if (!current[customerId]) return current;
        const next = { ...current };
        delete next[customerId];
        return next;
      });
    } else {
      this.unreadEmailByCustomer.update(current => {
        if (!current[customerId]) return current;
        const next = { ...current };
        delete next[customerId];
        return next;
      });
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

  private hasSchedule(customerId: string): boolean {
    if (!customerId) return false;
    return this.scheduleItems().some(s => s.customerId === customerId && !s.isBlocked && s.start && s.end);
  }

  private syncScheduledLane() {
    const scheduledId = this.scheduledLaneId();
    if (!scheduledId) return;
    const map = { ...this.items() };
    const moved: WorkItem[] = [];
    for (const laneId of Object.keys(map)) {
      if (laneId === scheduledId) continue;
      if (this.isInProgressLaneById(laneId) || this.isCompletedLaneById(laneId)) continue;
      const keep: WorkItem[] = [];
      for (const it of map[laneId] || []) {
        const alreadyCheckedIn = !!(it.checkedInAt || '').trim();
        if (it.customerId && this.hasSchedule(it.customerId) && !alreadyCheckedIn) {
          moved.push({ ...it, laneId: scheduledId });
        } else {
          keep.push(it);
        }
      }
      map[laneId] = keep;
    }
    if (moved.length) {
      map[scheduledId] = [...(map[scheduledId] || []), ...moved];
      this.items.set(map);
      for (const it of moved) {
        this.itemsApi.update({ id: it.id, laneId: scheduledId }).subscribe();
      }
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
            this.status.set('Added to lane');
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
        const scheduledId = this.scheduledLaneId();
        const isScheduledLane = !!scheduledId && laneId === scheduledId;
        this.itemsApi.create(title, laneId).subscribe({
          next: created => {
            this.itemsApi.update({ id: created.id, customerId: cust.id }).subscribe({
              next: () => {
                this.laneToLinkAfterSave.set(null);
                this.status.set('Added to lane');
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
      if (moved && (moved.checkedInAt || '').trim()) {
        const fromInProgress = this.isInProgressLaneById(sourceId);
        const toCompleted = this.isCompletedLaneById(targetLaneId);
        if (fromInProgress && !toCompleted) {
          this.status.set('Checked-in jobs stay in Work In-Progress until moved to Completed.');
          return;
        }
      }
      const scheduledId = this.scheduledLaneId();
      if (scheduledId && targetLaneId === scheduledId && moved?.customerId && !this.hasSchedule(moved.customerId)) {
        this.openScheduleModal(moved.customerId);
        return;
      }

      transferArrayItem(map[sourceId], map[targetId], event.previousIndex, event.currentIndex);
      this.items.set(map);
      const updated = map[targetId][event.currentIndex];
      const toCompleted = this.isCompletedLaneById(targetLaneId);
      const updateBody: Partial<WorkItem> & { id: string } = { id: updated.id, laneId: targetLaneId };
      if ((updated.checkedInAt || '').trim() && toCompleted) {
        updateBody.completedAt = new Date().toISOString();
      }
      this.itemsApi.update(updateBody).subscribe({
        next: () => {
          map[targetId] = [...map[targetId]].sort((a, b) => this.compareCreatedDesc(a, b));
          map[sourceId] = [...map[sourceId]].sort((a, b) => this.compareCreatedDesc(a, b));
          this.items.set(map);
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
