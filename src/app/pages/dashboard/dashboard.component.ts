import { Component, signal, computed, effect, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import {
  IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton,
  IonItem, IonLabel, IonInput, IonSpinner, IonIcon, IonModal,
  IonList, IonPopover
} from '@ionic/angular/standalone';
import { ToastController } from '@ionic/angular';
import { FormsModule } from '@angular/forms';
import {
  CdkDropList, CdkDrag, CdkDragDrop,
  moveItemInArray, transferArrayItem
} from '@angular/cdk/drag-drop';
import { LanesApi, Lane } from '../../services/lanes-api.service';
import { WorkItemsApi, WorkItem } from '../../services/workitems-api.service';
import { CustomersApi, Customer } from '../../services/customers-api.service';
import { ScheduleApi, ScheduleItem } from '../../services/schedule-api.service';
import { SmsApiService } from '../../services/sms-api.service';
import { EmailApiService } from '../../services/email-api.service';
import { InvoiceDetail, InvoicesDataService } from '../../services/invoices-data.service';
import CustomerModalComponent from '../../components/customer/customer-modal/customer-modal.component';
import ScheduleModalComponent from '../../components/schedule/schedule-modal/schedule-modal.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { addIcons } from 'ionicons';
import {
  ellipsisVertical,
  addOutline,
  reorderTwoOutline,
  checkmarkCircle
} from 'ionicons/icons';
import { HttpClient } from '@angular/common/http';
import { UserScopedSettingsService } from '../../services/user-scoped-settings.service';
import { catchError, firstValueFrom, forkJoin, of } from 'rxjs';
import { InvoiceResponseApiService } from '../../services/invoice-response-api.service';
import { QuoteResponseApiService } from '../../services/quote-response-api.service';
import { NotificationsApiService } from '../../services/notifications-api.service';
import { AuthService } from '../../auth/auth.service';

type ColorOpt = { label: string; hex: string };
type OnboardingStep = { selector: string; title: string; body: string };
const LANE_COLORS_SETTING_KEY = 'dashboard.laneColors';
const DASHBOARD_ONBOARDING_KEY = 'dashboard.onboarding.v1.completed';
const DASHBOARD_SEEN_LEADS_KEY = 'dashboard.leads.seen.v1';
const DASHBOARD_SEEN_CARDS_KEY = 'dashboard.cards.seen.v1';
const DASHBOARD_NOTIFIED_LEADS_KEY = 'dashboard.leads.notified.v1';
const DASHBOARD_CARD_SEEN_KEY_SEPARATOR = '::';
const NOTIFICATION_OPENED_HINTS_KEY = 'pathflow.notifications.opened.v1';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
    IonHeader, IonToolbar, IonTitle, IonContent, IonButtons, IonButton,
    IonItem, IonLabel, IonInput, IonSpinner, IonIcon, IonModal,
    IonList, IonPopover,
    CdkDropList, CdkDrag,
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
  scheduleModalOpen = signal(false);
  scheduleModalCustomerId = signal<string | null>(null);
  unreadActivityByCustomer = signal<Record<string, number>>({});
  unreadEmailByCustomer = signal<Record<string, number>>({});
  unreadSmsIdsByCustomer = signal<Record<string, string[]>>({});
  unreadEmailIdsByCustomer = signal<Record<string, string[]>>({});
  readonly invoiceDetails = computed(() => this.invoicesData.invoiceDetails());
  isMobileLayout = signal(false);
  onboardingActive = signal(false);
  onboardingStepIndex = signal(0);
  onboardingRect = signal<{ top: number; left: number; width: number; height: number } | null>(null);
  onboardingCurrentStep = computed(() => this.onboardingSteps[this.onboardingStepIndex()] || null);
  onboardingBubbleStyle = computed(() => {
    const rect = this.onboardingRect();
    if (!rect || typeof window === 'undefined') return {};
    const width = 340;
    const margin = 14;
    const panelHeight = 180;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    let left = rect.left;
    let top = rect.top + rect.height + 12;

    if (left + width > viewportWidth - margin) left = viewportWidth - width - margin;
    if (left < margin) left = margin;
    if (top + panelHeight > viewportHeight - margin) top = rect.top - panelHeight - 12;
    if (top < margin) top = margin;

    return {
      left: `${Math.round(left)}px`,
      top: `${Math.round(top)}px`,
      width: `${width}px`
    };
  });

  private onboardingChecked = false;
  readonly onboardingSteps: OnboardingStep[] = [
    {
      selector: '#dashboard-user-menu-guide-target',
      title: 'Account & Admin',
      body: 'Use this top-right menu for account actions and Admin Settings.'
    },
    {
      selector: '.lane-settings-btn',
      title: 'Lane Colors',
      body: 'Use the lane 3-dot menu to set each lane color.'
    },
    {
      selector: '#workspace-nav-guide-target',
      title: 'Main Navigation',
      body: 'Use this left navigation to move between dashboard, calendar, customers, inventory, invoices, and reports.'
    }
  ];

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
    private invoicesData: InvoicesDataService,
    private invoiceResponseApi: InvoiceResponseApiService,
    private quoteResponseApi: QuoteResponseApiService,
    private notificationsApi: NotificationsApiService,
    private auth: AuthService,
    private http: HttpClient,
    private userSettings: UserScopedSettingsService,
    private router: Router,
    private toastController: ToastController
  ) {
    addIcons({
      'ellipsis-vertical': ellipsisVertical,
      'add-outline': addOutline,
      'reorder-two-outline': reorderTwoOutline,
      'checkmark-circle': checkmarkCircle
    });

    this.updateResponsiveLayout();
    effect(() => {
      this.userSettings.scope();
      this.loadLaneColors();
      this.loadSeenLeads();
      this.loadSeenCards();
      this.loadNotifiedLeads();
    });
    this.loadAll();
    this.checkApi();
    this.syncQuoteResponsesFromApi();
    this.syncInvoiceResponsesFromApi();
    this.refreshUnreadActivity();
    this.apiCheckTimer = setInterval(() => this.checkApi(), 600000);
    this.unreadActivityTimer = setInterval(() => this.refreshUnreadActivity(), 5000);
    this.quoteResponseSyncTimer = setInterval(() => this.syncQuoteResponsesFromApi(), 10000);
    this.invoiceResponseSyncTimer = setInterval(() => this.syncInvoiceResponsesFromApi(), 10000);

    effect(() => {
      const value = this.laneColors();
      if (!this.laneColorsLoaded) return;
      if (this.laneColorPersistTimer) clearTimeout(this.laneColorPersistTimer);
      this.laneColorPersistTimer = setTimeout(() => {
        this.userSettings.setValue(LANE_COLORS_SETTING_KEY, value).subscribe({ error: () => {} });
      }, 120);
    });

    effect(() => {
      const value = this.seenLeadIds();
      if (!this.seenLeadsLoaded || !this.seenLeadsInitialized) return;
      if (this.seenLeadsPersistTimer) clearTimeout(this.seenLeadsPersistTimer);
      this.seenLeadsPersistTimer = setTimeout(() => {
        const ids = Object.keys(value).filter(Boolean);
        this.userSettings.setValue(DASHBOARD_SEEN_LEADS_KEY, {
          initialized: true,
          ids
        }).subscribe({ error: () => {} });
      }, 120);
    });

    effect(() => {
      const value = this.seenCardIds();
      if (!this.seenCardsLoaded || !this.seenCardsInitialized) return;
      if (this.seenCardsPersistTimer) clearTimeout(this.seenCardsPersistTimer);
      this.seenCardsPersistTimer = setTimeout(() => {
        const ids = Object.keys(value).filter(Boolean);
        this.userSettings.setValue(DASHBOARD_SEEN_CARDS_KEY, {
          initialized: true,
          ids
        }).subscribe({ error: () => {} });
      }, 120);
    });

    effect(() => {
      const value = this.notifiedLeadIds();
      if (!this.notifiedLeadsLoaded || !this.notifiedLeadsInitialized) return;
      if (this.notifiedLeadsPersistTimer) clearTimeout(this.notifiedLeadsPersistTimer);
      this.notifiedLeadsPersistTimer = setTimeout(() => {
        const ids = Object.keys(value).filter(Boolean);
        this.userSettings.setValue(DASHBOARD_NOTIFIED_LEADS_KEY, {
          initialized: true,
          ids
        }).subscribe({ error: () => {} });
      }, 120);
    });

    effect(() => {
      const msg = this.status();
      if (this.statusTimer) { clearTimeout(this.statusTimer); this.statusTimer = null; }
      if (this.statusFadeTimer) { clearTimeout(this.statusFadeTimer); this.statusFadeTimer = null; }
      if (msg) {
        void this.presentStatusToast(msg);
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
  private quoteResponseSyncTimer: any = null;
  private invoiceResponseSyncTimer: any = null;
  private laneColorPersistTimer: any = null;
  private laneColorsLoadToken = 0;
  private laneColorsLoaded = false;
  private seenLeadsPersistTimer: any = null;
  private seenLeadsLoadToken = 0;
  private seenLeadsLoaded = false;
  private seenLeadsInitialized = false;
  private seenCardsPersistTimer: any = null;
  private seenCardsLoadToken = 0;
  private seenCardsLoaded = false;
  private seenCardsInitialized = false;
  private notifiedLeadsPersistTimer: any = null;
  private notifiedLeadsLoadToken = 0;
  private notifiedLeadsLoaded = false;
  private notifiedLeadsInitialized = false;
  private interactivityRestoreTimer: any = null;
  private lastToastMessage = '';
  private lastToastAt = 0;
  seenLeadIds = signal<Record<string, true>>({});
  seenCardIds = signal<Record<string, true>>({});
  notifiedLeadIds = signal<Record<string, true>>({});

  private async presentStatusToast(message: string): Promise<void> {
    const value = String(message || '').trim();
    if (!value) return;
    const now = Date.now();
    if (this.lastToastMessage === value && now - this.lastToastAt < 1200) return;
    this.lastToastMessage = value;
    this.lastToastAt = now;
    const lowered = value.toLowerCase();
    const color = /(error|failed|missing|cannot|invalid|not|required)/.test(lowered) ? 'danger' : 'success';
    const toast = await this.toastController.create({
      message: value,
      color,
      duration: 1700,
      position: 'top'
    });
    await toast.present();
  }

  ngOnDestroy() {
    if (this.apiCheckTimer) { clearInterval(this.apiCheckTimer); this.apiCheckTimer = null; }
    if (this.unreadActivityTimer) { clearInterval(this.unreadActivityTimer); this.unreadActivityTimer = null; }
    if (this.quoteResponseSyncTimer) { clearInterval(this.quoteResponseSyncTimer); this.quoteResponseSyncTimer = null; }
    if (this.invoiceResponseSyncTimer) { clearInterval(this.invoiceResponseSyncTimer); this.invoiceResponseSyncTimer = null; }
    if (this.laneColorPersistTimer) { clearTimeout(this.laneColorPersistTimer); this.laneColorPersistTimer = null; }
    if (this.seenLeadsPersistTimer) { clearTimeout(this.seenLeadsPersistTimer); this.seenLeadsPersistTimer = null; }
    if (this.seenCardsPersistTimer) { clearTimeout(this.seenCardsPersistTimer); this.seenCardsPersistTimer = null; }
    if (this.notifiedLeadsPersistTimer) { clearTimeout(this.notifiedLeadsPersistTimer); this.notifiedLeadsPersistTimer = null; }
    if (this.interactivityRestoreTimer) { clearTimeout(this.interactivityRestoreTimer); this.interactivityRestoreTimer = null; }
  }

  ionViewWillEnter() {
    this.loadAll();
    this.refreshUnreadActivity();
    this.maybeStartOnboarding();
  }

  @HostListener('window:resize')
  onWindowResize() {
    this.updateResponsiveLayout();
    this.refreshOnboardingTarget();
  }

  private updateResponsiveLayout() {
    if (typeof window === 'undefined') return;
    this.isMobileLayout.set(window.innerWidth <= 900);
  }

  private maybeStartOnboarding(): void {
    if (this.onboardingChecked) return;
    this.onboardingChecked = true;
    this.userSettings.getValue<boolean>(DASHBOARD_ONBOARDING_KEY).subscribe({
      next: done => {
        if (done === true) return;
        setTimeout(() => this.startOnboarding(), 180);
      },
      error: () => {
        setTimeout(() => this.startOnboarding(), 180);
      }
    });
  }

  private startOnboarding(): void {
    this.onboardingStepIndex.set(0);
    this.onboardingActive.set(true);
    this.refreshOnboardingTarget(true);
  }

  private refreshOnboardingTarget(autoAdvance = false): void {
    if (!this.onboardingActive()) return;
    const step = this.onboardingCurrentStep();
    if (!step) {
      this.completeOnboarding();
      return;
    }

    const element = this.resolveOnboardingElement(step.selector);
    if (!element) {
      if (autoAdvance) {
        this.nextOnboardingStep(true);
      } else {
        this.onboardingRect.set(null);
      }
      return;
    }

    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      if (autoAdvance) this.nextOnboardingStep(true);
      return;
    }

    const pad = 8;
    this.onboardingRect.set({
      top: Math.max(6, rect.top - pad),
      left: Math.max(6, rect.left - pad),
      width: rect.width + (pad * 2),
      height: rect.height + (pad * 2)
    });
  }

  private resolveOnboardingElement(selector: string): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLElement)) return null;
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return null;
    return node;
  }

  nextOnboardingStep(fromAutoAdvance = false): void {
    if (!this.onboardingActive()) return;
    const next = this.onboardingStepIndex() + 1;
    if (next >= this.onboardingSteps.length) {
      this.completeOnboarding();
      return;
    }
    this.onboardingStepIndex.set(next);
    this.refreshOnboardingTarget(fromAutoAdvance);
  }

  prevOnboardingStep(): void {
    if (!this.onboardingActive()) return;
    const prev = this.onboardingStepIndex() - 1;
    if (prev < 0) return;
    this.onboardingStepIndex.set(prev);
    this.refreshOnboardingTarget();
  }

  skipOnboarding(): void {
    this.completeOnboarding();
  }

  private completeOnboarding(): void {
    this.onboardingActive.set(false);
    this.onboardingRect.set(null);
    this.userSettings.setValue(DASHBOARD_ONBOARDING_KEY, true).subscribe({ error: () => {} });
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

  laneStageKey(lane: Lane | null | undefined): string {
    const explicit = (lane?.stageKey || '').trim().toLowerCase();
    if (explicit) return explicit;
    const name = (lane?.name || '').trim().toLowerCase();
    if (!name) return 'custom';
    if (/quote|estimate/.test(name)) return 'quote';
    if (/lead/.test(name)) return 'lead';
    if (/sched|appointment|calendar/.test(name)) return 'scheduled';
    if (/in[- ]?progress|work in progress|progress/.test(name)) return 'inprogress';
    if (/invoice|invoiced|paid/.test(name)) return 'invoiced';
    if (/complete|completed|done|pickup|ready/.test(name)) return 'completed';
    return 'custom';
  }

  isProtectedLane(lane: Lane | null | undefined): boolean {
    if (!lane) return false;
    if (lane.protected) return true;
    const stageKey = this.laneStageKey(lane);
    return stageKey === 'lead'
      || stageKey === 'quote'
      || stageKey === 'invoiced'
      || stageKey === 'scheduled'
      || stageKey === 'inprogress'
      || stageKey === 'completed';
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

  private isLeadLaneById(laneId: string): boolean {
    const lane = this.lanes().find(item => item.id === laneId) || null;
    return this.laneStageKey(lane) === 'lead';
  }

  private isScheduleRequiredLaneById(laneId: string): boolean {
    const lane = this.lanes().find(item => item.id === laneId) || null;
    const stage = this.laneStageKey(lane);
    return stage === 'scheduled' || stage === 'inprogress' || stage === 'completed';
  }

  private isQuoteLaneById(laneId: string): boolean {
    const lane = this.lanes().find(item => item.id === laneId) || null;
    return this.laneStageKey(lane) === 'quote';
  }

  private inProgressLaneId(): string | null {
    const lane = this.lanes().find(item => this.isInProgressLane(item));
    return lane?.id || null;
  }

  private workflowLaneStage(stageKey: string): boolean {
    return stageKey === 'lead'
      || stageKey === 'quote'
      || stageKey === 'invoiced'
      || stageKey === 'scheduled'
      || stageKey === 'inprogress'
      || stageKey === 'completed';
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

  private roundCurrency(value: number): number {
    return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
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
    if (!this.isInProgressLane(lane)) return false;
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

  laneMenuLane(): Lane | null {
    const laneId = this.laneMenuLaneId();
    if (!laneId) return null;
    return this.lanes().find(item => item.id === laneId) || null;
  }

  setLaneColorFromMenu(color: string): void {
    const lane = this.laneMenuLane();
    if (!lane) return;
    this.setLaneColor(lane, String(color || '').trim());
    this.closeLaneMenu();
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

  canRevertCheckInFromCardMenu(): boolean {
    const item = this.findItemById(this.cardMenuItemId());
    const lane = this.laneForItem(item);
    if (!item || !lane) return false;
    if (!this.isInProgressLane(lane)) return false;
    return this.canRevertCheckIn(item, lane);
  }

  revertCheckInFromCardMenu(): void {
    const item = this.findItemById(this.cardMenuItemId());
    const lane = this.laneForItem(item);
    this.cardMenuOpen.set(false);
    if (!item || !lane) return;
    if (!this.isInProgressLane(lane)) return;
    this.revertCheckInCard(item, lane);
  }

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
    const snapshot = this.removeItemsLocally([itId]);
    this.itemsApi.delete(itId).subscribe({
      next: () => this.status.set('Removed'),
      error: () => {
        this.items.set(snapshot);
        this.status.set('Remove error');
      }
    });
  }

  private removeItemsLocally(itemIds: string[]): Record<string, WorkItem[]> {
    const ids = new Set(itemIds.map(id => (id || '').trim()).filter(Boolean));
    const current = this.items();
    const snapshot: Record<string, WorkItem[]> = {};
    const next: Record<string, WorkItem[]> = {};

    for (const [laneId, rows] of Object.entries(current)) {
      const cloned = [...rows];
      snapshot[laneId] = cloned;
      next[laneId] = ids.size ? cloned.filter(item => !ids.has(item.id)) : cloned;
    }

    this.items.set(next);
    return snapshot;
  }

  private removeCustomerTargetItemIds(itemId: string, customerId: string): string[] {
    const ids = new Set<string>();
    const cleanedItemId = (itemId || '').trim();
    if (cleanedItemId) ids.add(cleanedItemId);

    const cleanedCustomerId = (customerId || '').trim();
    const leadLaneId = this.leadLaneId();
    if (!cleanedCustomerId || !leadLaneId) return [...ids];

    for (const item of this.items()[leadLaneId] || []) {
      if ((item.customerId || '').trim() !== cleanedCustomerId) continue;
      if (!item.id) continue;
      ids.add(item.id);
    }
    return [...ids];
  }

  cardRemoveLabel(): string {
    const item = this.findItemById(this.cardMenuItemId());
    const lane = this.laneForItem(item);
    if (this.isWorkflowStatusLane(lane)) return 'Remove customer';
    return 'Remove from lane';
  }

  removeCustomerWarningMessage(): string {
    const customerId = String(this.removeCustomerCustomerId() || '').trim();
    const docKinds = this.removeCustomerDocumentKinds(customerId);
    if (docKinds === 'both') {
      return 'This will cancel the quote and invoice for this customer. Are you sure you want to do this?';
    }
    if (docKinds === 'invoice') {
      return 'This will cancel the invoice for this customer. Are you sure you want to do this?';
    }
    if (docKinds === 'quote') {
      return 'This will cancel the quote for this customer. Are you sure you want to do this?';
    }
    return 'Are you sure you want to take them out of their current status?';
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
    const customer = customerId ? this.customersMap()[customerId] : null;
    const affectedDocs = customerId ? this.matchedActiveDocumentsForCustomer(customerId) : [];
    this.cancelRemoveCustomer();
    if (!itemId) return;

    this.status.set('Removing customer');
    const targetItemIds = this.removeCustomerTargetItemIds(itemId, customerId);
    const snapshot = this.removeItemsLocally(targetItemIds);

    const deleteWorkItem = () => {
      if (!targetItemIds.length) {
        this.status.set('Customer removed');
        return;
      }
      const deletes = targetItemIds.map(id =>
        this.itemsApi.delete(id).pipe(catchError(() => of({ ok: false })))
      );
      forkJoin(deletes).subscribe({
        next: results => {
          const hasFailure = results.some(result => !result?.ok);
          if (hasFailure) {
            this.items.set(snapshot);
            this.status.set('Remove error');
            this.loadAll();
            return;
          }
          const canceledDocs = this.invoicesData.cancelForCustomer({
            id: customerId || undefined,
            email: String(customer?.email || '').trim().toLowerCase() || undefined,
            name: String(customer?.name || '').trim() || undefined
          });
          if (canceledDocs > 0) {
            void this.sendCancellationEmailsForDocuments(affectedDocs, customerId);
            this.status.set('Customer removed and quote/invoice canceled');
            return;
          }
          this.status.set('Customer removed');
        },
        error: () => {
          this.items.set(snapshot);
          this.status.set('Remove error');
          this.loadAll();
        }
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

  private removeCustomerDocumentKinds(customerId: string): 'none' | 'quote' | 'invoice' | 'both' {
    const id = String(customerId || '').trim();
    if (!id) return 'none';
    const customer = this.customersMap()[id] || null;
    const email = String(customer?.email || '').trim().toLowerCase();
    const name = String(customer?.name || '').trim().toLowerCase();

    let hasQuote = false;
    let hasInvoice = false;
    for (const doc of this.invoiceDetails()) {
      if (!this.isCancelableDocumentForRemoval(doc)) continue;
      const docCustomerId = String(doc.customerId || '').trim();
      const docEmail = String(doc.customerEmail || '').trim().toLowerCase();
      const docName = String(doc.customerName || '').trim().toLowerCase();
      const matches =
        (!!id && !!docCustomerId && id === docCustomerId)
        || (!!email && !!docEmail && email === docEmail)
        || (!!name && !!docName && name === docName);
      if (!matches) continue;
      if (doc.documentType === 'quote') hasQuote = true;
      if (doc.documentType === 'invoice') hasInvoice = true;
    }

    if (hasQuote && hasInvoice) return 'both';
    if (hasInvoice) return 'invoice';
    if (hasQuote) return 'quote';
    return 'none';
  }

  private matchedActiveDocumentsForCustomer(customerId: string): InvoiceDetail[] {
    const id = String(customerId || '').trim();
    if (!id) return [];
    const customer = this.customersMap()[id] || null;
    const email = String(customer?.email || '').trim().toLowerCase();
    const name = String(customer?.name || '').trim().toLowerCase();

    return this.invoiceDetails().filter(doc => {
      if (!this.isCancelableDocumentForRemoval(doc)) return false;
      const docCustomerId = String(doc.customerId || '').trim();
      const docEmail = String(doc.customerEmail || '').trim().toLowerCase();
      const docName = String(doc.customerName || '').trim().toLowerCase();
      return (
        (!!id && !!docCustomerId && id === docCustomerId)
        || (!!email && !!docEmail && email === docEmail)
        || (!!name && !!docName && name === docName)
      );
    });
  }

  private isCancelableDocumentForRemoval(doc: InvoiceDetail): boolean {
    if (doc.stage === 'canceled' || doc.stage === 'expired') return false;
    if (doc.documentType === 'invoice' && (doc.stage === 'accepted' || doc.stage === 'completed')) return false;
    return true;
  }

  private async sendCancellationEmailsForDocuments(docs: InvoiceDetail[], customerId: string): Promise<void> {
    const customer = this.customersMap()[String(customerId || '').trim()] || null;
    const customerName = String(customer?.name || docs[0]?.customerName || 'Customer').trim();
    const seen = new Set<string>();
    const sends = docs
      .filter(doc => this.shouldSendCancellationEmail(doc))
      .filter(doc => {
        const id = String(doc.id || '').trim();
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map(async doc => {
        const to = String(doc.customerEmail || customer?.email || '').trim();
        if (!to) return { skipped: true };
        const business = String(doc.businessName || 'Your Company').trim();
        const docLabel = doc.documentType === 'invoice' ? 'invoice' : 'quote';
        const subject = `${doc.documentType === 'invoice' ? 'Invoice' : 'Quote'} ${doc.invoiceNumber} canceled`;
        const plain = `Hi ${customerName}, your ${docLabel} ${doc.invoiceNumber} has been canceled. If you have questions, reply to this email and ${business} will help.`;
        const html = `<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#111827;">
          <p>Hi ${this.escapeHtml(customerName)},</p>
          <p>Your ${this.escapeHtml(docLabel)} <strong>${this.escapeHtml(doc.invoiceNumber)}</strong> has been canceled.</p>
          <p>If you have questions, reply to this email and ${this.escapeHtml(business)} will help.</p>
        </div>`;
        await firstValueFrom(this.emailApi.sendToCustomer({
          customerId: String(doc.customerId || customerId || '').trim(),
          customerName,
          to,
          subject,
          message: plain,
          html
        }));
        return { skipped: false };
      });

    const settled = await Promise.allSettled(sends);
    const attempted = settled.some(item => item.status === 'fulfilled' && !item.value.skipped);
    const failed = settled.some(item => item.status === 'rejected');
    if (attempted && failed) {
      this.status.set('Customer removed and quote/invoice canceled. Some cancellation emails failed.');
    }
  }

  private shouldSendCancellationEmail(doc: InvoiceDetail): boolean {
    const stage = String(doc?.stage || '').trim().toLowerCase();
    if (!stage || stage === 'draft') return false;
    if (doc.documentType === 'invoice') {
      // Only notify invoice cancellation if the invoice had already been sent.
      return stage === 'sent';
    }
    // Quotes may be customer-visible across sent/accepted/declined.
    return stage === 'sent' || stage === 'accepted' || stage === 'declined';
  }

  private escapeHtml(value: string): string {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  loadSeenLeads() {
    this.seenLeadsLoaded = false;
    this.seenLeadsInitialized = false;
    const token = ++this.seenLeadsLoadToken;
    this.userSettings.getValue<{ initialized?: boolean; ids?: string[] }>(DASHBOARD_SEEN_LEADS_KEY).subscribe({
      next: value => {
        if (token !== this.seenLeadsLoadToken) return;
        const normalized = this.normalizeSeenLeads(value);
        this.seenLeadIds.set(normalized.ids);
        this.seenLeadsInitialized = normalized.initialized;
        this.seenLeadsLoaded = true;
        this.maybeInitializeSeenLeads(this.items());
      },
      error: () => {
        if (token !== this.seenLeadsLoadToken) return;
        this.seenLeadIds.set({});
        this.seenLeadsInitialized = false;
        this.seenLeadsLoaded = true;
        this.maybeInitializeSeenLeads(this.items());
      }
    });
  }

  loadSeenCards() {
    this.seenCardsLoaded = false;
    this.seenCardsInitialized = false;
    const token = ++this.seenCardsLoadToken;
    this.userSettings.getValue<{ initialized?: boolean; ids?: string[] }>(DASHBOARD_SEEN_CARDS_KEY).subscribe({
      next: value => {
        if (token !== this.seenCardsLoadToken) return;
        const normalized = this.normalizeSeenLeads(value);
        this.seenCardIds.set(normalized.ids);
        this.seenCardsInitialized = normalized.initialized;
        this.seenCardsLoaded = true;
        this.maybeInitializeSeenCards(this.items());
      },
      error: () => {
        if (token !== this.seenCardsLoadToken) return;
        this.seenCardIds.set({});
        this.seenCardsInitialized = false;
        this.seenCardsLoaded = true;
        this.maybeInitializeSeenCards(this.items());
      }
    });
  }

  loadNotifiedLeads() {
    this.notifiedLeadsLoaded = false;
    this.notifiedLeadsInitialized = false;
    const token = ++this.notifiedLeadsLoadToken;
    this.userSettings.getValue<{ initialized?: boolean; ids?: string[] }>(DASHBOARD_NOTIFIED_LEADS_KEY).subscribe({
      next: value => {
        if (token !== this.notifiedLeadsLoadToken) return;
        const normalized = this.normalizeSeenLeads(value);
        this.notifiedLeadIds.set(normalized.ids);
        this.notifiedLeadsInitialized = normalized.initialized;
        this.notifiedLeadsLoaded = true;
        this.maybeInitializeNotifiedLeads(this.items());
        this.maybeNotifyNewLeads(this.items());
      },
      error: () => {
        if (token !== this.notifiedLeadsLoadToken) return;
        this.notifiedLeadIds.set({});
        this.notifiedLeadsInitialized = false;
        this.notifiedLeadsLoaded = true;
        this.maybeInitializeNotifiedLeads(this.items());
        this.maybeNotifyNewLeads(this.items());
      }
    });
  }

  private normalizeSeenLeads(value: unknown): { initialized: boolean; ids: Record<string, true> } {
    const out: Record<string, true> = {};
    if (!value || typeof value !== 'object') {
      return { initialized: false, ids: out };
    }
    const source = value as { initialized?: unknown; ids?: unknown };
    const ids = Array.isArray(source.ids) ? source.ids : [];
    for (const raw of ids) {
      const id = String(raw || '').trim();
      if (!id) continue;
      out[id] = true;
    }
    return {
      initialized: source.initialized === true,
      ids: out
    };
  }

  private maybeInitializeSeenLeads(map: Record<string, WorkItem[]>): void {
    if (!this.seenLeadsLoaded || this.seenLeadsInitialized) return;
    const leadLaneIds = this.lanes()
      .filter(lane => this.laneStageKey(lane) === 'lead')
      .map(lane => lane.id);
    const next: Record<string, true> = {};
    for (const laneId of leadLaneIds) {
      for (const item of map[laneId] || []) {
        const id = String(item.id || '').trim();
        if (!id) continue;
        next[id] = true;
      }
    }
    this.seenLeadIds.set(next);
    this.seenLeadsInitialized = true;
  }

  private maybeInitializeNotifiedLeads(map: Record<string, WorkItem[]>): void {
    if (!this.notifiedLeadsLoaded || this.notifiedLeadsInitialized) return;
    const leadLaneIds = this.lanes()
      .filter(lane => this.laneStageKey(lane) === 'lead')
      .map(lane => lane.id);
    const next: Record<string, true> = {};
    for (const laneId of leadLaneIds) {
      for (const item of map[laneId] || []) {
        const id = String(item.id || '').trim();
        if (!id) continue;
        next[id] = true;
      }
    }
    this.notifiedLeadIds.set(next);
    this.notifiedLeadsInitialized = true;
  }

  private maybeNotifyNewLeads(map: Record<string, WorkItem[]>): void {
    if (!this.seenLeadsLoaded || !this.seenLeadsInitialized) return;
    if (!this.notifiedLeadsLoaded || !this.notifiedLeadsInitialized) return;

    const user = this.auth.user();
    if (!user) return;
    const targetUserId = String(user.id || '').trim();
    const targetEmail = String(user.email || '').trim();
    if (!targetUserId && !targetEmail) return;

    const leadLaneIds = this.lanes()
      .filter(lane => this.laneStageKey(lane) === 'lead')
      .map(lane => lane.id);
    if (!leadLaneIds.length) return;

    const seen = this.seenLeadIds();
    const notified = this.notifiedLeadIds();
    for (const laneId of leadLaneIds) {
      for (const item of map[laneId] || []) {
        const itemId = String(item.id || '').trim();
        if (!itemId) continue;
        if (seen[itemId] || notified[itemId]) continue;
        const leadSource = String((item as any).leadSource || '').trim().toLowerCase();
        if (leadSource === 'web') {
          this.notifiedLeadIds.update(current => ({ ...current, [itemId]: true }));
          continue;
        }
        this.notifiedLeadIds.update(current => ({ ...current, [itemId]: true }));
        const leadName = this.customerName(item);
        const customerId = String(item.customerId || '').trim();
        this.notificationsApi.createMention({
          targetUserId: targetUserId || undefined,
          targetEmail: targetEmail || undefined,
          targetDisplayName: String(user.displayName || '').trim() || undefined,
          title: `${leadName} submitted a new lead`,
          message: `${leadName} submitted a new lead.`,
          route: customerId ? `/customers/${encodeURIComponent(customerId)}` : '/dashboard',
          entityType: 'lead',
          entityId: customerId || itemId,
          metadata: {
            leadItemId: itemId,
            customerId,
            source: 'dashboard-new-lead'
          }
        }).subscribe({
          next: () => {
            this.emitNotificationsRefresh();
          },
          error: () => {
            this.notifiedLeadIds.update(current => {
              const next = { ...current };
              delete next[itemId];
              return next;
            });
          }
        });
      }
    }
  }

  private maybeInitializeSeenCards(map: Record<string, WorkItem[]>): void {
    if (!this.seenCardsLoaded) return;
    if (this.seenCardsInitialized) {
      this.migrateLegacySeenCards(map);
      return;
    }
    const next: Record<string, true> = {};
    for (const [laneId, rows] of Object.entries(map || {})) {
      for (const item of rows || []) {
        const id = String(item.id || '').trim();
        if (!id) continue;
        next[this.cardSeenKey(id, laneId)] = true;
      }
    }
    this.seenCardIds.set(next);
    this.seenCardsInitialized = true;
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
    if (explicitStage) return `stage:${explicitStage}`;
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
                    this.maybeInitializeSeenLeads(map);
                    this.maybeInitializeSeenCards(map);
                    this.maybeInitializeNotifiedLeads(map);
                    this.maybeNotifyNewLeads(map);
                    this.applyOpenedNotificationSeenHints(map);
                    this.syncFinalPaidInvoicesToCompleted();
                    this.syncScheduledLane();
                    this.pruneExpiredCompletedFromBoard();
                    this.syncInvoiceResponsesFromApi();
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
                    this.maybeInitializeSeenLeads(map);
                    this.maybeInitializeSeenCards(map);
                    this.maybeInitializeNotifiedLeads(map);
                    this.maybeNotifyNewLeads(map);
                    this.applyOpenedNotificationSeenHints(map);
                    this.syncFinalPaidInvoicesToCompleted();
                    this.pruneExpiredCompletedFromBoard();
                    this.syncInvoiceResponsesFromApi();
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

  linkedDocumentLabel(it: WorkItem, lane: Lane): string {
    const doc = this.linkedDocumentForCard(it, lane);
    if (!doc) return '';
    return `${doc.documentType === 'invoice' ? 'Invoice' : 'Quote'}: ${doc.invoiceNumber}`;
  }

  linkedDocumentStatusLabel(it: WorkItem, lane: Lane): string {
    const doc = this.linkedDocumentForCard(it, lane);
    if (!doc) return '';
    if (doc.documentType === 'invoice') {
      if (doc.stage === 'completed') return 'Completed';
      if (doc.stage === 'accepted') return 'Paid';
      if (doc.stage === 'draft') return 'Draft';
      if (doc.stage === 'sent') return 'Sent';
      if (doc.stage === 'declined') return 'Declined';
      if (doc.stage === 'canceled') return 'Canceled';
      if (doc.stage === 'expired') return 'Expired';
      return doc.stage;
    }
    if (doc.stage === 'accepted') return 'Accepted';
    if (doc.stage === 'draft') return 'Draft';
    if (doc.stage === 'sent') return 'Sent';
    if (doc.stage === 'declined') return 'Declined';
    if (doc.stage === 'canceled') return 'Canceled';
    if (doc.stage === 'expired') return 'Expired';
    return doc.stage;
  }

  linkedDocumentStatusClass(it: WorkItem, lane: Lane): string {
    const doc = this.linkedDocumentForCard(it, lane);
    if (!doc) return '';
    if (doc.documentType === 'invoice' && (doc.stage === 'accepted' || doc.stage === 'completed')) return 'is-paid';
    if (doc.stage === 'draft') return 'is-draft';
    if (doc.stage === 'sent') return 'is-sent';
    if (doc.stage === 'accepted') return 'is-accepted';
    if (doc.stage === 'declined') return 'is-declined';
    if (doc.stage === 'canceled') return 'is-canceled';
    if (doc.stage === 'expired') return 'is-expired';
    return '';
  }

  linkedDocumentStatusTimeLabel(it: WorkItem, lane: Lane): string {
    const doc = this.linkedDocumentForCard(it, lane);
    if (!doc) return '';
    const stamp = String(doc.updatedAt || doc.createdAt || '').trim();
    if (!stamp) return '';
    return this.relativeTimeLabel(stamp);
  }

  hasLinkedDocument(it: WorkItem, lane: Lane): boolean {
    return !!this.linkedDocumentForCard(it, lane);
  }

  openLinkedDocument(it: WorkItem, lane: Lane, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.markCardSeen(it, lane);
    this.markLeadSeen(it, lane);
    const doc = this.linkedDocumentForCard(it, lane);
    if (!doc) return;
    if (doc.documentType === 'quote') {
      this.router.navigate(['/quotes', doc.id || doc.invoiceNumber]);
      return;
    }
    this.router.navigate(['/invoices', doc.id]);
  }

  private linkedDocumentForCard(it: WorkItem, lane: Lane): InvoiceDetail | null {
    const stage = this.laneStageKey(lane);
    if (stage !== 'quote' && stage !== 'invoiced') return null;
    const customerId = String(it.customerId || '').trim();
    const customer = this.customersMap()[customerId] || null;
    const email = String(customer?.email || '').trim().toLowerCase();
    const name = this.customerName(it).trim().toLowerCase();

    const matched = this.invoiceDetails()
      .filter(doc => {
        const docCustomerId = String(doc.customerId || '').trim();
        if (customerId && docCustomerId && docCustomerId === customerId) return true;
        const docEmail = String(doc.customerEmail || '').trim().toLowerCase();
        if (email && docEmail && docEmail === email) return true;
        const docName = String(doc.customerName || '').trim().toLowerCase();
        return !!name && !!docName && docName === name;
      });

    if (!matched.length) return null;
    if (stage === 'invoiced') {
      const invoices = matched
        .filter(doc => doc.documentType === 'invoice');
      const activeInvoices = invoices.filter(doc => doc.stage !== 'canceled' && doc.stage !== 'expired');
      const candidates = activeInvoices.length ? activeInvoices : invoices;
      return candidates
        .filter(doc => doc.documentType === 'invoice')
        .sort((a, b) => {
          const updatedDiff = this.asMillis(b.updatedAt || b.createdAt || '') - this.asMillis(a.updatedAt || a.createdAt || '');
          if (updatedDiff !== 0) return updatedDiff;
          const priorityDiff = this.invoiceStagePriority(b.stage) - this.invoiceStagePriority(a.stage);
          if (priorityDiff !== 0) return priorityDiff;
          return this.asMillis(b.createdAt || '') - this.asMillis(a.createdAt || '');
        })[0] || null;
    }
    return matched
      .filter(doc => doc.documentType === 'quote')
      .sort((a, b) => {
        const priorityDiff = this.quoteStagePriority(b.stage) - this.quoteStagePriority(a.stage);
        if (priorityDiff !== 0) return priorityDiff;
        return this.asMillis(b.updatedAt || b.createdAt || '') - this.asMillis(a.updatedAt || a.createdAt || '');
      })[0] || null;
  }

  private quoteStagePriority(stage: InvoiceDetail['stage']): number {
    if (stage === 'accepted') return 6;
    if (stage === 'sent') return 5;
    if (stage === 'draft') return 4;
    if (stage === 'declined') return 3;
    if (stage === 'expired') return 2;
    if (stage === 'canceled') return 1;
    return 0;
  }

  private invoiceStagePriority(stage: InvoiceDetail['stage']): number {
    if (stage === 'completed') return 6;
    if (stage === 'accepted') return 5;
    if (stage === 'sent') return 4;
    if (stage === 'draft') return 3;
    if (stage === 'declined') return 2;
    if (stage === 'expired') return 1;
    if (stage === 'canceled') return 1;
    return 0;
  }

  private latestInvoiceDocumentForCard(it: WorkItem): InvoiceDetail | null {
    const matches = this.matchedInvoicesForCard(it)
      .filter(doc => doc.documentType === 'invoice')
      .sort((a, b) => {
        const stageDiff = this.invoiceStagePriority(b.stage) - this.invoiceStagePriority(a.stage);
        if (stageDiff !== 0) return stageDiff;
        return this.asMillis(b.updatedAt || b.createdAt || '') - this.asMillis(a.updatedAt || a.createdAt || '');
      });
    return matches[0] || null;
  }

  private latestPaidInvoiceDocumentForCard(it: WorkItem): InvoiceDetail | null {
    const invoices = this.matchedInvoicesForCard(it)
      .filter(doc => doc.documentType === 'invoice' && doc.stage !== 'canceled' && doc.stage !== 'expired');
    if (!invoices.length) return null;

    const withOutstandingFinalBalance = invoices
      .filter(doc => {
        const total = this.roundCurrency(Math.max(0, Number(doc.total || 0)));
        const paid = this.roundCurrency(Math.max(0, Number((doc as any).paidAmount || 0)));
        return paid > 0 && this.roundCurrency(total - paid) > 0;
      })
      .sort((a, b) => this.asMillis(b.updatedAt || b.createdAt || '') - this.asMillis(a.updatedAt || a.createdAt || ''));
    if (withOutstandingFinalBalance.length) return withOutstandingFinalBalance[0] || null;

    const paidInvoices = invoices
      .filter(doc => doc.stage === 'accepted' || doc.stage === 'completed')
      .sort((a, b) => this.asMillis(b.updatedAt || b.createdAt || '') - this.asMillis(a.updatedAt || a.createdAt || ''));
    if (!paidInvoices.length) return null;
    return paidInvoices[0] || null;
  }

  private matchedInvoicesForCard(it: WorkItem): InvoiceDetail[] {
    const customerId = String(it.customerId || '').trim();
    const customer = this.customersMap()[customerId] || null;
    const email = String(customer?.email || '').trim().toLowerCase();
    const name = this.customerName(it).trim().toLowerCase();

    return this.invoiceDetails().filter(doc => {
      const docCustomerId = String(doc.customerId || '').trim();
      if (customerId && docCustomerId && docCustomerId === customerId) return true;
      const docEmail = String(doc.customerEmail || '').trim().toLowerCase();
      if (email && docEmail && docEmail === email) return true;
      const docName = String(doc.customerName || '').trim().toLowerCase();
      return !!name && !!docName && docName === name;
    });
  }

  private isInvoicePaidInFull(doc: InvoiceDetail): boolean {
    if (doc.documentType !== 'invoice' || (doc.stage !== 'accepted' && doc.stage !== 'completed')) return false;
    const total = this.roundCurrency(Math.max(0, Number(doc.total || 0)));
    const paid = this.roundCurrency(Math.max(0, Number((doc as any).paidAmount || 0)));
    if (total <= 0) return false;
    return this.roundCurrency(total - paid) <= 0;
  }

  private isFinalInvoiceSendLocked(doc: InvoiceDetail): boolean {
    if (!doc || doc.documentType !== 'invoice') return false;
    const total = this.roundCurrency(Math.max(0, Number(doc.total || 0)));
    const paid = this.roundCurrency(Math.max(0, Number((doc as any).paidAmount || 0)));
    const due = this.roundCurrency(Math.max(0, total - paid));
    if (paid <= 0 || due <= 0) return false;
    const sentAt = this.latestTimelineEventAt(doc, 'final invoice sent to customer');
    if (!sentAt) return false;
    const updatedAt = this.latestTimelineEventAt(doc, 'final invoice updated after send');
    return !updatedAt || sentAt >= updatedAt;
  }

  private latestTimelineEventAt(doc: InvoiceDetail, needle: string): number {
    const target = String(needle || '').trim().toLowerCase();
    if (!target) return 0;
    let latest = 0;
    for (const entry of doc.timeline || []) {
      const message = String(entry?.message || '').trim().toLowerCase();
      if (!message.includes(target)) continue;
      const stamp = this.asMillis(String(entry?.createdAt || '').trim());
      if (stamp > latest) latest = stamp;
    }
    return latest;
  }

  private hasStageTransitionAfter(doc: InvoiceDetail, targetStage: 'sent' | 'accepted' | 'completed', afterMs: number): boolean {
    const needle = `updated to ${targetStage}`;
    return (doc.timeline || []).some(entry => {
      const createdAtMs = this.asMillis(entry.createdAt || '');
      if (!createdAtMs || createdAtMs < afterMs) return false;
      return String(entry.message || '').toLowerCase().includes(needle);
    });
  }

  private finalPaidInvoiceForCheckedInItem(it: WorkItem): InvoiceDetail | null {
    const checkedInAtMs = this.asMillis((it.checkedInAt || '').trim());
    if (!checkedInAtMs) return null;

    const settledInvoices = this.matchedInvoicesForCard(it)
      .filter(doc => this.isInvoicePaidInFull(doc))
      .sort((a, b) => this.asMillis(b.updatedAt || b.createdAt || '') - this.asMillis(a.updatedAt || a.createdAt || ''));
    if (!settledInvoices.length) return null;

    for (const doc of settledInvoices) {
      const finalSentAtMs = this.latestTimelineEventAt(doc, 'final invoice sent to customer');
      if (!finalSentAtMs || finalSentAtMs < checkedInAtMs) continue;
      const paidAtMs = this.asMillis(doc.updatedAt || doc.paymentDate || doc.createdAt || '');
      if (paidAtMs && paidAtMs < finalSentAtMs) continue;
      return doc;
    }
    return null;
  }

  completionBadgeLabel(it: WorkItem, lane: Lane): string {
    if (!this.isCompletedLane(lane)) return '';
    return this.finalPaidInvoiceForCheckedInItem(it) ? 'Paid in Full' : '';
  }

  needsScheduledBadgeLabel(it: WorkItem, lane: Lane): string {
    if (this.laneStageKey(lane) !== 'invoiced') return '';
    const doc = this.linkedDocumentForCard(it, lane);
    if (!doc || doc.documentType !== 'invoice') return '';
    if (doc.stage !== 'accepted' && doc.stage !== 'completed') return '';
    const customerId = String(it.customerId || '').trim();
    if (!customerId) return '';
    return this.hasCalendarEvent(customerId) ? '' : 'Needs Scheduled';
  }

  private relativeTimeLabel(value: string): string {
    const ts = Date.parse(String(value || '').trim());
    if (!Number.isFinite(ts)) return '';
    const diffMs = Date.now() - ts;
    if (diffMs < 0) return 'just now';
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diffMs < minute) return 'just now';
    if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))}m ago`;
    if (diffMs < day) return `${Math.max(1, Math.floor(diffMs / hour))}h ago`;
    if (diffMs < day * 7) return `${Math.max(1, Math.floor(diffMs / day))}d ago`;
    return new Intl.DateTimeFormat('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }).format(new Date(ts));
  }

  hasUnreadActivity(it: WorkItem): boolean {
    return this.unreadSmsCount(it) > 0 || this.unreadEmailCount(it) > 0;
  }

  hasUnreadLeadNotice(it: WorkItem, lane: Lane): boolean {
    if (!this.isLeadLane(lane)) return false;
    if (!this.seenLeadsLoaded || !this.seenLeadsInitialized) return false;
    const id = String(it.id || '').trim();
    if (!id) return false;
    return !this.seenLeadIds()[id];
  }

  hasUnseenCardNotice(it: WorkItem, lane?: Lane): boolean {
    if (!this.seenCardsLoaded || !this.seenCardsInitialized) return false;
    const key = this.cardSeenKeyForItem(it, lane);
    if (!key) return false;
    return !this.seenCardIds()[key];
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

  openCustomerProfileFromCard(it: WorkItem, lane?: Lane, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    this.markCardSeen(it, lane);
    this.markLeadSeen(it, lane);
    const customerId = (it.customerId || '').trim();
    if (!customerId) return;
    this.router.navigate(['/customers', customerId]);
  }

  openCustomerActivity(it: WorkItem, lane: Lane, activity: 'sms' | 'email', event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    this.markCardSeen(it, lane);
    this.markLeadSeen(it, lane);
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

  openCustomerSmsById(customerId: string | null | undefined, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    const id = String(customerId || '').trim();
    if (!id) return;
    this.router.navigate(['/customers', id], { queryParams: { tab: 'sms' } });
  }

  createQuoteFromLead(it: WorkItem, lane: Lane, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    if (!this.isLeadLane(lane)) return;
    this.markCardSeen(it, lane);
    this.markLeadSeen(it, lane);
    const customerId = String(it.customerId || '').trim();
    if (!customerId) {
      this.status.set('No customer linked to this lead yet.');
      return;
    }
    this.openQuoteBuilderForCustomer(customerId);
  }

  canCreateInvoiceFromQuote(it: WorkItem, lane: Lane): boolean {
    if (this.laneStageKey(lane) !== 'quote') return false;
    const doc = this.linkedDocumentForCard(it, lane);
    if (!doc) return false;
    return doc.documentType === 'quote' && doc.stage === 'accepted';
  }

  async createInvoiceFromQuoteCard(it: WorkItem, lane: Lane, event?: Event): Promise<void> {
    event?.stopPropagation();
    event?.preventDefault();
    if (!this.canCreateInvoiceFromQuote(it, lane)) return;
    this.markCardSeen(it, lane);
    this.markLeadSeen(it, lane);
    const doc = this.linkedDocumentForCard(it, lane);
    if (!doc) return;
    const created = this.invoicesData.createInvoiceFromQuote(doc.id || doc.invoiceNumber);
    if (!created) {
      this.status.set('Could not create invoice from quote.');
      return;
    }

    const targetLaneId = this.invoicedLaneId();
    if (targetLaneId && targetLaneId !== String(it.laneId || '').trim()) {
      this.items.update(current => {
        const next: Record<string, WorkItem[]> = {};
        for (const [laneId, rows] of Object.entries(current || {})) {
          next[laneId] = [...(rows || [])].filter(row => row.id !== it.id);
        }
        const targetRows = next[targetLaneId] || [];
        targetRows.unshift({ ...it, laneId: targetLaneId });
        next[targetLaneId] = targetRows;
        return next;
      });
      try {
        await firstValueFrom(this.itemsApi.update({ id: it.id, laneId: targetLaneId }));
      } catch {
        this.status.set(`Created invoice ${created.invoiceNumber}, but could not move card to Invoices lane.`);
        this.loadAll();
      }
    }

    this.status.set(`Created invoice ${created.invoiceNumber}.`);
    await this.router.navigate(['/invoices', created.id], {
      queryParams: { openSendModal: '1' }
    });
  }

  canOpenFinalInvoice(it: WorkItem, lane: Lane): boolean {
    if (this.laneStageKey(lane) !== 'inprogress') return false;
    return !!this.latestPaidInvoiceDocumentForCard(it);
  }

  isFinalInvoiceSendDisabled(it: WorkItem): boolean {
    const doc = this.latestPaidInvoiceDocumentForCard(it);
    return !!doc && this.isFinalInvoiceSendLocked(doc);
  }

  finalInvoiceActionLabel(it: WorkItem): string {
    return this.isFinalInvoiceSendDisabled(it) ? 'Final invoice sent' : 'Send Final Invoice';
  }

  openFinalInvoiceFromInProgress(it: WorkItem, lane: Lane, event?: Event): void {
    event?.stopPropagation();
    event?.preventDefault();
    if (!this.canOpenFinalInvoice(it, lane)) return;
    if (this.isFinalInvoiceSendDisabled(it)) return;
    this.markCardSeen(it, lane);
    this.markLeadSeen(it, lane);
    const doc = this.latestPaidInvoiceDocumentForCard(it);
    if (doc) {
      this.router.navigate(['/invoices', doc.id], {
        queryParams: { openSendModal: '1' }
      });
      return;
    }
    this.status.set('Final invoice is available after an initial invoice is paid.');
  }

  customerContact(it: WorkItem): string {
    const c = this.customersMap()[it.customerId ?? ''];
    return c?.phone || c?.email || '';
  }

  customerPhone(it: WorkItem): string {
    const c = this.customersMap()[it.customerId ?? ''];
    return String(c?.phone || '').trim();
  }

  canOpenSmsFromCard(it: WorkItem): boolean {
    return !!String(it.customerId || '').trim() && !!this.customerPhone(it);
  }

  isLeadLane(lane: Lane): boolean {
    return this.laneStageKey(lane) === 'lead';
  }

  private markLeadSeen(it: WorkItem, lane?: Lane): void {
    if (!lane || !this.isLeadLane(lane)) return;
    if (!this.seenLeadsLoaded || !this.seenLeadsInitialized) return;
    const itemId = String(it.id || '').trim();
    if (!itemId) return;
    const current = this.seenLeadIds();
    if (current[itemId]) return;
    const next: Record<string, true> = {
      ...current,
      [itemId]: true
    };
    this.seenLeadIds.set(next);
    this.persistSeenLeadsNow(next);
  }

  private markCardSeen(it: WorkItem, lane?: Lane): void {
    if (!this.seenCardsLoaded || !this.seenCardsInitialized) return;
    const key = this.cardSeenKeyForItem(it, lane);
    if (!key) return;
    const current = this.seenCardIds();
    if (current[key]) return;
    const next: Record<string, true> = {
      ...current,
      [key]: true
    };
    this.seenCardIds.set(next);
    this.persistSeenCardsNow(next);
  }

  private cardSeenKey(itemId: string, laneId: string): string {
    const safeItemId = String(itemId || '').trim();
    const safeLaneId = String(laneId || '').trim();
    if (!safeItemId || !safeLaneId) return '';
    return `${safeItemId}${DASHBOARD_CARD_SEEN_KEY_SEPARATOR}${safeLaneId}`;
  }

  private cardSeenKeyForItem(it: WorkItem, lane?: Lane): string {
    const itemId = String(it?.id || '').trim();
    const laneId = String(lane?.id || it?.laneId || '').trim();
    return this.cardSeenKey(itemId, laneId);
  }

  private migrateLegacySeenCards(map: Record<string, WorkItem[]>): void {
    const current = this.seenCardIds();
    const keys = Object.keys(current);
    if (!keys.length) return;
    const legacyKeys = keys.filter(key => !key.includes(DASHBOARD_CARD_SEEN_KEY_SEPARATOR));
    if (!legacyKeys.length) return;

    const legacySet = new Set(legacyKeys);
    let changed = false;
    const next: Record<string, true> = { ...current };
    for (const [laneId, rows] of Object.entries(map || {})) {
      for (const item of rows || []) {
        const itemId = String(item.id || '').trim();
        if (!itemId || !legacySet.has(itemId)) continue;
        const laneAwareKey = this.cardSeenKey(itemId, laneId);
        if (!laneAwareKey || next[laneAwareKey]) continue;
        next[laneAwareKey] = true;
        changed = true;
      }
    }
    if (!changed) return;
    this.seenCardIds.set(next);
    this.persistSeenCardsNow(next);
  }

  private persistSeenLeadsNow(idsMap?: Record<string, true>): void {
    const source = idsMap || this.seenLeadIds();
    const ids = Object.keys(source).filter(Boolean);
    this.userSettings.setValue(DASHBOARD_SEEN_LEADS_KEY, {
      initialized: true,
      ids
    }).subscribe({ error: () => {} });
  }

  private persistSeenCardsNow(idsMap?: Record<string, true>): void {
    const source = idsMap || this.seenCardIds();
    const ids = Object.keys(source).filter(Boolean);
    this.userSettings.setValue(DASHBOARD_SEEN_CARDS_KEY, {
      initialized: true,
      ids
    }).subscribe({ error: () => {} });
  }

  private applyOpenedNotificationSeenHints(map: Record<string, WorkItem[]>): void {
    if (typeof window === 'undefined') return;
    if (!this.seenLeadsLoaded || !this.seenLeadsInitialized) return;
    if (!this.seenCardsLoaded || !this.seenCardsInitialized) return;

    let raw = '';
    try {
      raw = String(localStorage.getItem(NOTIFICATION_OPENED_HINTS_KEY) || '');
    } catch {
      return;
    }
    if (!raw) return;

    let parsed: Array<Record<string, unknown>> = [];
    try {
      const value = JSON.parse(raw);
      parsed = Array.isArray(value) ? value : [];
    } catch {
      return;
    }
    if (!parsed.length) return;

    const nowMs = Date.now();
    const keepHints: Array<Record<string, unknown>> = [];
    const seenLeadIds = { ...this.seenLeadIds() };
    const seenCardIds = { ...this.seenCardIds() };
    let changed = false;

    for (const hint of parsed) {
      const openedAtMs = this.asMillis(String(hint['openedAt'] || ''));
      if (openedAtMs && nowMs - openedAtMs > 7 * 24 * 60 * 60 * 1000) {
        continue;
      }

      const metadata = (hint['metadata'] && typeof hint['metadata'] === 'object')
        ? (hint['metadata'] as Record<string, unknown>)
        : {};
      const entityType = String(hint['entityType'] || '').trim().toLowerCase();
      const entityId = String(hint['entityId'] || '').trim();
      const metadataLeadItemId = String(metadata['leadItemId'] || '').trim();
      const metadataCustomerId = String(metadata['customerId'] || '').trim();
      const metadataQuoteId = String(metadata['quoteId'] || '').trim();
      const metadataQuoteNumber = String(metadata['quoteNumber'] || '').trim().toLowerCase();
      const metadataInvoiceId = String(metadata['invoiceId'] || '').trim();
      const metadataInvoiceNumber = String(metadata['invoiceNumber'] || '').trim().toLowerCase();
      const entityIdLower = entityId.toLowerCase();

      const matchedItems: Array<{ laneId: string; item: WorkItem }> = [];
      const lanes = this.lanes();
      for (const [laneId, rows] of Object.entries(map || {})) {
        const lane = lanes.find(entry => String(entry.id || '').trim() === laneId) || null;
        for (const row of rows || []) {
          const itemId = String(row.id || '').trim();
          const customerId = String(row.customerId || '').trim();
          if (!itemId) continue;
          const leadMatch = !!metadataLeadItemId && itemId === metadataLeadItemId;
          const customerMatch = !!metadataCustomerId && customerId === metadataCustomerId;
          const entityCustomerMatch = entityType === 'customer' && !!entityId && customerId === entityId;
          const entityLeadMatch = entityType === 'lead' && !!entityId && (itemId === entityId || customerId === entityId);
          let docMatch = false;
          if (lane && (entityType === 'quote' || entityType === 'invoice')) {
            const linked = this.linkedDocumentForCard(row, lane);
            if (linked) {
              const linkedId = String(linked.id || '').trim();
              const linkedNumber = String(linked.invoiceNumber || '').trim().toLowerCase();
              if (entityType === 'quote' && linked.documentType === 'quote') {
                docMatch =
                  (!!metadataQuoteId && linkedId === metadataQuoteId)
                  || (!!metadataQuoteNumber && linkedNumber === metadataQuoteNumber)
                  || (!!entityId && (linkedId === entityId || linkedNumber === entityIdLower));
              } else if (entityType === 'invoice' && linked.documentType === 'invoice') {
                docMatch =
                  (!!metadataInvoiceId && linkedId === metadataInvoiceId)
                  || (!!metadataInvoiceNumber && linkedNumber === metadataInvoiceNumber)
                  || (!!entityId && (linkedId === entityId || linkedNumber === entityIdLower));
              }
            }
          }
          if (leadMatch || customerMatch || entityCustomerMatch || entityLeadMatch || docMatch) {
            matchedItems.push({ laneId, item: row });
          }
        }
      }

      if (!matchedItems.length) {
        keepHints.push(hint);
        continue;
      }

      for (const match of matchedItems) {
        const itemId = String(match.item.id || '').trim();
        if (!itemId) continue;
        if (!seenLeadIds[itemId]) {
          seenLeadIds[itemId] = true;
          changed = true;
        }
        const cardKey = this.cardSeenKey(itemId, match.laneId);
        if (cardKey && !seenCardIds[cardKey]) {
          seenCardIds[cardKey] = true;
          changed = true;
        }
      }
    }

    try {
      localStorage.setItem(NOTIFICATION_OPENED_HINTS_KEY, JSON.stringify(keepHints.slice(-100)));
    } catch {
      // Ignore local storage failures.
    }

    if (!changed) return;
    this.seenLeadIds.set(seenLeadIds);
    this.seenCardIds.set(seenCardIds);
    this.persistSeenLeadsNow(seenLeadIds);
    this.persistSeenCardsNow(seenCardIds);
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

    const itemParts = [it.vehicleYear, it.vehicleMake, it.vehicleModel]
      .filter(Boolean)
      .map((s: string | undefined) => String(s || '').trim())
      .filter(Boolean);
    if (itemParts.length) return itemParts.join(' ');

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
    if (idx >= 0) {
      let note = title.slice(idx + 2);
      note = note.replace(/\[c=[^\]]+\]/gi, '').trim().replace(/\s{2,}/g, ' ');
      if (note) return note;
    }

    const customerId = String(it.customerId || '').trim();
    const customerEmail = String(cust?.email || '').trim().toLowerCase();
    const customerName = this.customerName(it).trim().toLowerCase();
    const doc = this.invoiceDetails()
      .filter(row => {
        const rowCustomerId = String(row.customerId || '').trim();
        if (customerId && rowCustomerId && rowCustomerId === customerId) return true;
        const rowEmail = String(row.customerEmail || '').trim().toLowerCase();
        if (customerEmail && rowEmail && rowEmail === customerEmail) return true;
        const rowName = String(row.customerName || '').trim().toLowerCase();
        return !!customerName && !!rowName && rowName === customerName;
      })
      .sort((a, b) => this.asMillis(b.updatedAt || b.createdAt || '') - this.asMillis(a.updatedAt || a.createdAt || ''))[0];
    if (!doc) return '';
    return String(doc.staffNote || doc.customerNote || '').trim();
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

  private invoicedLaneId(): string | null {
    const lane = this.lanes().find(l => this.laneStageKey(l) === 'invoiced');
    return lane?.id || null;
  }

  private leadLaneId(): string | null {
    const lane = this.lanes().find(l => this.laneStageKey(l) === 'lead');
    return lane?.id || null;
  }

  private hasActiveInvoiceForCard(it: WorkItem): boolean {
    return this.matchedInvoicesForCard(it).some(doc =>
      doc.documentType === 'invoice' &&
      doc.stage !== 'canceled' &&
      doc.stage !== 'expired'
    );
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

  private effectiveScheduleEndMs(item: ScheduleItem): number {
    const plannedEnd = this.asMillis(item.end || '');
    const actualEnd = this.asMillis(item.actualEnd || '');
    const releasedAt = this.asMillis(item.bayReleasedAt || '');
    let effective = plannedEnd;
    if (actualEnd && (!effective || actualEnd < effective)) effective = actualEnd;
    if (releasedAt && (!effective || releasedAt < effective)) effective = releasedAt;
    return effective;
  }

  private activeScheduleIdsForCustomerAt(customerId: string, atMs: number): string[] {
    const key = String(customerId || '').trim();
    if (!key) return [];
    return this.scheduleItems()
      .filter(item => {
        if (!!item.isBlocked) return false;
        if (String(item.customerId || '').trim() !== key) return false;
        const startMs = this.asMillis(item.start || '');
        const endMs = this.effectiveScheduleEndMs(item);
        if (!startMs || !endMs || endMs <= startMs) return false;
        return startMs <= atMs && atMs < endMs;
      })
      .map(item => String(item.id || '').trim())
      .filter(Boolean);
  }

  private releaseActiveBayForCustomer(customerId: string, releasedAtIso: string): void {
    const whenMs = this.asMillis(releasedAtIso);
    if (!whenMs) return;
    const targetIds = new Set(this.activeScheduleIdsForCustomerAt(customerId, whenMs));
    if (!targetIds.size) return;

    this.scheduleItems.update(rows =>
      rows.map(item => {
        const id = String(item.id || '').trim();
        if (!targetIds.has(id)) return item;
        return {
          ...item,
          actualEnd: releasedAtIso,
          bayReleasedAt: releasedAtIso
        };
      })
    );

    for (const id of targetIds) {
      this.scheduleApi
        .update({ id, actualEnd: releasedAtIso, bayReleasedAt: releasedAtIso })
        .subscribe({ error: () => {} });
    }
  }

  private reopenReleasedBayForCustomer(customerId: string): void {
    const nowMs = Date.now();
    const key = String(customerId || '').trim();
    if (!key) return;
    const candidates = this.scheduleItems()
      .filter(item => {
        if (!!item.isBlocked) return false;
        if (String(item.customerId || '').trim() !== key) return false;
        if (!String(item.bayReleasedAt || '').trim()) return false;
        const startMs = this.asMillis(item.start || '');
        const endMs = this.asMillis(item.end || '');
        return !!startMs && !!endMs && startMs <= nowMs && nowMs < endMs;
      })
      .map(item => String(item.id || '').trim())
      .filter(Boolean);
    if (!candidates.length) return;

    const targetIds = new Set(candidates);
    this.scheduleItems.update(rows =>
      rows.map(item => {
        const id = String(item.id || '').trim();
        if (!targetIds.has(id)) return item;
        return {
          ...item,
          actualEnd: '',
          bayReleasedAt: ''
        };
      })
    );

    for (const id of candidates) {
      this.scheduleApi
        .update({ id, actualEnd: '', bayReleasedAt: '' })
        .subscribe({ error: () => {} });
    }
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
    const inProgressId = this.inProgressLaneId();
    const invoicedId = this.invoicedLaneId();
    const nowMs = Date.now();
    const futureCustomerIds = this.futureScheduleCustomerIds(nowMs);
    const activeCheckedInCustomerIds = new Set<string>();
    const customersWithProtectedLaneCards = new Set<string>();
    const map: Record<string, WorkItem[]> = {};
    for (const [laneId, rows] of Object.entries(this.items())) {
      map[laneId] = [...rows];
      for (const row of rows || []) {
        const customerId = String(row.customerId || '').trim();
        if (!customerId) continue;
        const hasCheckIn = !!String(row.checkedInAt || '').trim();
        const isCompleted = !!String(row.completedAt || '').trim();
        if (hasCheckIn && !isCompleted) {
          activeCheckedInCustomerIds.add(customerId);
        }
        if (this.isInProgressLaneById(laneId) || this.isCompletedLaneById(laneId) || isCompleted) {
          customersWithProtectedLaneCards.add(customerId);
        }
      }
    }

    const movedToScheduled: WorkItem[] = [];
    const movedOutOfScheduled: Array<{ item: WorkItem; targetLaneId: string }> = [];
    const removedFromScheduled: WorkItem[] = [];
    for (const laneId of Object.keys(map)) {
      if (this.isInProgressLaneById(laneId) || this.isCompletedLaneById(laneId)) continue;
      const keep: WorkItem[] = [];
      for (const it of map[laneId] || []) {
        const alreadyCheckedIn = !!(it.checkedInAt || '').trim();
        const customerId = (it.customerId || '').trim();
        const hasFutureSchedule = customerId ? futureCustomerIds.has(customerId) : false;
        const hasActiveCheckIn = customerId ? activeCheckedInCustomerIds.has(customerId) : false;
        const hasProtectedLaneCard = customerId ? customersWithProtectedLaneCards.has(customerId) : false;

        if (laneId !== scheduledId) {
          if (customerId && hasFutureSchedule && !alreadyCheckedIn && !hasActiveCheckIn && !this.isLeadLaneById(laneId)) {
            movedToScheduled.push({ ...it, laneId: scheduledId });
            continue;
          }
          keep.push(it);
          continue;
        }

        // Keep scheduled cards in Scheduled so appointment save/race conditions do not bounce them back to Leads.
        if (!customerId) {
          keep.push(it);
          continue;
        }

        const moveToInProgress =
          alreadyCheckedIn && inProgressId && inProgressId !== scheduledId;
        if (moveToInProgress) {
          movedOutOfScheduled.push({ item: { ...it, laneId: inProgressId }, targetLaneId: inProgressId });
          continue;
        }

        const moveBackToInvoices =
          !hasFutureSchedule &&
          !alreadyCheckedIn &&
          !hasActiveCheckIn &&
          !!invoicedId &&
          invoicedId !== scheduledId &&
          this.hasActiveInvoiceForCard(it);
        if (moveBackToInvoices) {
          movedOutOfScheduled.push({ item: { ...it, laneId: invoicedId }, targetLaneId: invoicedId });
          continue;
        }

        if (hasProtectedLaneCard && !hasFutureSchedule && !alreadyCheckedIn && !hasActiveCheckIn) {
          // Only remove duplicate scheduled cards when there is no future appointment to preserve.
          removedFromScheduled.push(it);
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

    if (movedToScheduled.length || movedOutOfScheduled.length || removedFromScheduled.length) {
      this.items.set(map);
      this.maybeInitializeSeenLeads(map);
      this.maybeInitializeSeenCards(map);
      this.maybeInitializeNotifiedLeads(map);
      this.maybeNotifyNewLeads(map);
      for (const it of movedToScheduled) {
        this.itemsApi.update({ id: it.id, laneId: scheduledId }).subscribe();
      }
      for (const move of movedOutOfScheduled) {
        this.itemsApi.update({ id: move.item.id, laneId: move.targetLaneId }).subscribe();
      }
      for (const it of removedFromScheduled) {
        this.itemsApi.delete(it.id).subscribe({ error: () => {} });
      }
    }

    const scheduledCustomers = new Set(
      (map[scheduledId] || [])
        .map(item => (item.customerId || '').trim())
        .filter(Boolean)
    );
    const customersWithNonScheduledCards = new Set(
      Object.entries(map)
        .filter(([laneId]) => laneId !== scheduledId)
        .flatMap(([, rows]) => (rows || []).map(item => (item.customerId || '').trim()))
        .filter(Boolean)
    );
    const missingScheduledCards = [...futureCustomerIds].filter(customerId => !scheduledCustomers.has(customerId));
    const missingWithoutActiveCheckIn = missingScheduledCards.filter(customerId =>
      !activeCheckedInCustomerIds.has(customerId) &&
      !customersWithProtectedLaneCards.has(customerId) &&
      !customersWithNonScheduledCards.has(customerId)
    );
    if (missingWithoutActiveCheckIn.length) {
      this.ensureScheduledCardsForCustomers(missingWithoutActiveCheckIn, scheduledId);
    }
  }

  private completedLaneId(): string | null {
    const lane = this.lanes().find(item => this.isCompletedLane(item));
    return lane?.id || null;
  }

  private syncFinalPaidInvoicesToCompleted(): void {
    const inProgressLaneId = this.inProgressLaneId();
    const completedLaneId = this.completedLaneId();
    if (!inProgressLaneId || !completedLaneId || inProgressLaneId === completedLaneId) return;

    const current = this.items();
    const inProgressRows = [...(current[inProgressLaneId] || [])];
    if (!inProgressRows.length) return;

    const moves = inProgressRows
      .map(item => {
        const paidInvoice = this.finalPaidInvoiceForCheckedInItem(item);
        if (!paidInvoice) return null;

        const completedAtMs = this.asMillis(paidInvoice.updatedAt || paidInvoice.paymentDate || paidInvoice.createdAt || '');
        const completedAt = (completedAtMs ? new Date(completedAtMs) : new Date()).toISOString();
        const completionTiming = this.buildCompletionTimingPatch(item, completedAt);
        return {
          currentItem: item,
          nextItem: {
            ...item,
            ...completionTiming,
            laneId: completedLaneId,
            completedAt,
            calendarOverrideAt: ''
          } as WorkItem,
          patch: {
            id: item.id,
            laneId: completedLaneId,
            completedAt,
            calendarOverrideAt: '',
            ...completionTiming
          } as Partial<WorkItem> & { id: string }
        };
      })
      .filter((row): row is {
        currentItem: WorkItem;
        nextItem: WorkItem;
        patch: Partial<WorkItem> & { id: string };
      } => !!row);

    if (!moves.length) return;

    const movedIds = new Set(moves.map(move => move.currentItem.id));
    const nextMap: Record<string, WorkItem[]> = {};
    for (const [laneId, rows] of Object.entries(current)) {
      nextMap[laneId] = [...(rows || [])];
    }
    nextMap[inProgressLaneId] = (nextMap[inProgressLaneId] || []).filter(item => !movedIds.has(item.id));
    nextMap[completedLaneId] = [...moves.map(move => move.nextItem), ...(nextMap[completedLaneId] || [])];

    this.items.set(nextMap);
    this.maybeInitializeSeenLeads(nextMap);
    this.maybeInitializeSeenCards(nextMap);
    this.maybeInitializeNotifiedLeads(nextMap);
    this.maybeNotifyNewLeads(nextMap);

    for (const move of moves) {
      this.itemsApi.update(move.patch).subscribe({ error: () => {} });
      const customerId = String(move.currentItem.customerId || '').trim();
      if (customerId) {
        this.releaseActiveBayForCustomer(customerId, String(move.nextItem.completedAt || new Date().toISOString()));
      }
    }
  }

  private syncInvoiceResponsesFromApi(): void {
    this.invoiceResponseApi.listRecent(250).subscribe({
      next: response => {
        const items = Array.isArray(response?.items) ? response.items : [];
        let applied = false;

        for (const item of items) {
          const invoiceId = String(item?.invoiceId || '').trim();
          const invoiceNumber = String(item?.invoiceNumber || '').trim();
          const stage = String(item?.stage || '').trim().toLowerCase();
          const responseUpdatedAt = String(item?.updatedAt || '').trim();
          if (!invoiceId || stage !== 'accepted') continue;

          const existing = this.invoicesData.getInvoiceById(invoiceId)
            || (invoiceNumber ? this.invoicesData.getInvoiceById(invoiceNumber) : null);
          if (!existing || existing.documentType !== 'invoice') continue;

          const responseUpdatedMs = this.asMillis(responseUpdatedAt || new Date().toISOString());
          const invoiceUpdatedMs = this.asMillis(existing.updatedAt || existing.createdAt || '');
          if (responseUpdatedMs && invoiceUpdatedMs && responseUpdatedMs < invoiceUpdatedMs) continue;

          const total = Number(existing.total || 0);
          const paid = Number(existing.paidAmount || 0);
          if ((existing.stage === 'accepted' || existing.stage === 'completed') && paid >= total) continue;
          const wasFinalInvoicePayment = paid > 0 && paid < total;

          this.invoicesData.setPaidAmount(existing.id, total, 'Customer paid invoice from public payment link.', 'customer');
          if (wasFinalInvoicePayment) {
            this.invoicesData.setStage(existing.id, 'completed', 'Final invoice paid by customer. Marked as Completed.', 'customer');
          } else {
            this.invoicesData.setStage(existing.id, 'accepted', 'Customer approved and paid invoice from public payment link.', 'customer');
          }
          this.markDashboardCardsAsUnseenForDocument(existing);
          this.createInvoicePaidNotification(existing.id, existing.invoiceNumber, existing.customerName, wasFinalInvoicePayment);
          applied = true;
        }

        if (!applied) return;
        this.syncFinalPaidInvoicesToCompleted();
        this.syncScheduledLane();
      },
      error: () => {
        // Keep dashboard functional when response sync endpoint is temporarily unavailable.
      }
    });
  }

  private syncQuoteResponsesFromApi(): void {
    this.quoteResponseApi.listRecent(250).subscribe({
      next: response => {
        const items = Array.isArray(response?.items) ? response.items : [];
        for (const item of items) {
          const quoteId = String(item?.quoteId || '').trim();
          const stage = String(item?.stage || '').trim().toLowerCase();
          if (!quoteId) continue;
          if (stage !== 'accepted' && stage !== 'declined') continue;

          const existing = this.invoicesData.getInvoiceById(quoteId);
          if (!existing || existing.documentType !== 'quote') continue;
          if (existing.stage === 'canceled' || existing.stage === 'expired') continue;
          if (existing.stage === stage) continue;

          this.invoicesData.setStage(
            existing.id,
            stage,
            `Customer ${stage === 'accepted' ? 'accepted' : 'declined'} quote from public link.`,
            'customer'
          );
          this.markDashboardCardsAsUnseenForDocument(existing);
          this.createQuoteStatusNotification(
            existing.id,
            existing.invoiceNumber,
            existing.customerName,
            stage as 'accepted' | 'declined'
          );
        }
      },
      error: () => {
        // Keep dashboard functional when response sync endpoint is temporarily unavailable.
      }
    });
  }

  private createQuoteStatusNotification(
    quoteId: string,
    quoteNumber: string,
    customerName: string,
    stage: 'accepted' | 'declined'
  ): void {
    const user = this.auth.user();
    if (!user) return;

    const targetUserId = String(user.id || '').trim();
    const targetEmail = String(user.email || '').trim();
    if (!targetUserId && !targetEmail) return;

    const number = String(quoteNumber || quoteId || '').trim() || 'Quote';
    const customer = String(customerName || '').trim() || 'Customer';
    const accepted = stage === 'accepted';

    this.notificationsApi.createMention({
      targetUserId: targetUserId || undefined,
      targetEmail: targetEmail || undefined,
      targetDisplayName: String(user.displayName || '').trim() || undefined,
      title: `Quote ${number} ${accepted ? 'accepted' : 'declined'}`,
      message: `${customer} ${accepted ? 'accepted' : 'declined'} quote ${number}.`,
      route: `/quotes/${encodeURIComponent(quoteId || number)}`,
      entityType: 'quote',
      entityId: quoteId || number,
      metadata: {
        quoteId: quoteId || '',
        quoteNumber: number,
        customerName: customer,
        stage,
        source: 'dashboard-response-sync'
      }
    }).subscribe({
      next: () => {
        this.emitNotificationsRefresh();
      },
      error: () => {
        // Notification failures must not block status sync.
      }
    });
  }

  private markDashboardCardsAsUnseenForDocument(doc: InvoiceDetail): void {
    if (!this.seenCardsLoaded || !this.seenCardsInitialized) return;

    const current = this.seenCardIds();
    const next = { ...current };
    let changed = false;

    for (const [laneId, rows] of Object.entries(this.items() || {})) {
      for (const row of rows || []) {
        if (!this.itemMatchesDocumentCustomer(row, doc)) continue;
        const key = this.cardSeenKey(String(row.id || '').trim(), laneId);
        if (!key || !next[key]) continue;
        delete next[key];
        changed = true;
      }
    }

    if (!changed) return;
    this.seenCardIds.set(next);
    this.persistSeenCardsNow(next);
  }

  private itemMatchesDocumentCustomer(item: WorkItem, doc: InvoiceDetail): boolean {
    const docCustomerId = String(doc.customerId || '').trim();
    const itemCustomerId = String(item.customerId || '').trim();
    if (docCustomerId && itemCustomerId && docCustomerId === itemCustomerId) return true;

    const customer = this.customersMap()[itemCustomerId] || null;
    const itemEmail = String(customer?.email || '').trim().toLowerCase();
    const docEmail = String(doc.customerEmail || '').trim().toLowerCase();
    if (docEmail && itemEmail && docEmail === itemEmail) return true;

    const itemName = this.customerName(item).trim().toLowerCase();
    const docName = String(doc.customerName || '').trim().toLowerCase();
    return !!docName && !!itemName && docName === itemName;
  }

  private createInvoicePaidNotification(
    invoiceId: string,
    invoiceNumber: string,
    customerName: string,
    isFinalInvoice: boolean
  ): void {
    const user = this.auth.user();
    if (!user) return;

    const targetUserId = String(user.id || '').trim();
    const targetEmail = String(user.email || '').trim();
    if (!targetUserId && !targetEmail) return;

    const number = String(invoiceNumber || invoiceId || '').trim() || 'Invoice';
    const customer = String(customerName || '').trim() || 'Customer';
    const titlePrefix = isFinalInvoice ? 'Final invoice' : 'Invoice';
    const messageBody = isFinalInvoice
      ? `${customer} paid final invoice ${number}.`
      : `${customer} paid invoice ${number}.`;

    this.notificationsApi.createMention({
      targetUserId: targetUserId || undefined,
      targetEmail: targetEmail || undefined,
      targetDisplayName: String(user.displayName || '').trim() || undefined,
      title: `${titlePrefix} ${number} paid`,
      message: messageBody,
      route: `/invoices/${encodeURIComponent(invoiceId || number)}`,
      entityType: 'invoice',
      entityId: invoiceId || number,
      metadata: {
        invoiceId: invoiceId || '',
        invoiceNumber: number,
        customerName: customer,
        stage: 'accepted',
        paymentKind: isFinalInvoice ? 'final' : 'initial',
        source: 'dashboard-response-sync'
      }
    }).subscribe({
      next: () => {
        this.emitNotificationsRefresh();
      },
      error: () => {
        // Do not block dashboard state updates on notification write failures.
      }
    });
  }

  private emitNotificationsRefresh(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('pathflow:notifications-refresh'));
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

  private openScheduleModalDeferred(customerId: string): void {
    const id = String(customerId || '').trim();
    if (!id) return;
    setTimeout(() => {
      this.clearResidualDragState();
      this.openScheduleModal(id);
    }, 220);
  }

  closeScheduleModal() {
    this.scheduleModalOpen.set(false);
    this.scheduleModalCustomerId.set(null);
    this.deferInteractivityRestore(220);
    setTimeout(() => this.forceOverlayInteractivityReset(), 200);
  }

  onScheduleSaved() {
    this.deferInteractivityRestore(260);
    // Let the nested appointment editor modal finish dismissing before closing the schedule modal.
    setTimeout(() => {
      this.closeScheduleModal();
      this.loadAll();
      this.deferInteractivityRestore(320);
      this.forceOverlayInteractivityReset();
    }, 160);
  }

  private clearResidualDragState(): void {
    if (typeof document === 'undefined') return;
    const draggingCards = document.querySelectorAll('.cdk-drag-dragging');
    draggingCards.forEach(node => node.classList.remove('cdk-drag-dragging'));

    const draggingLanes = document.querySelectorAll('.cdk-drop-list-dragging');
    draggingLanes.forEach(node => node.classList.remove('cdk-drop-list-dragging'));

    document.body.classList.remove('cdk-drag-drop-disable-native-interactions');

    const activeDrag = document.querySelector('.cdk-drag-dragging, .cdk-drop-list-dragging');
    if (!activeDrag) {
      document.querySelectorAll('.cdk-drag-preview, .cdk-drag-placeholder').forEach(node => node.remove());
    }
    this.forceOverlayInteractivityReset();
  }

  onCardDragEnded(): void {
    this.deferInteractivityRestore(100);
  }

  private deferInteractivityRestore(delayMs: number = 140): void {
    if (this.interactivityRestoreTimer) {
      clearTimeout(this.interactivityRestoreTimer);
      this.interactivityRestoreTimer = null;
    }
    this.interactivityRestoreTimer = setTimeout(() => {
      this.interactivityRestoreTimer = null;
      this.clearResidualDragState();
    }, Math.max(0, delayMs));
  }

  private forceOverlayInteractivityReset(): void {
    if (typeof document === 'undefined') return;
    const hasVisibleOverlay = !!document.querySelector(
      'ion-modal:not(.overlay-hidden), ion-popover:not(.overlay-hidden), ion-alert:not(.overlay-hidden), ion-action-sheet:not(.overlay-hidden), ion-loading:not(.overlay-hidden), ion-picker:not(.overlay-hidden)'
    );
    if (hasVisibleOverlay) return;

    document.querySelectorAll('ion-backdrop').forEach(node => {
      const el = node as HTMLElement;
      el.classList.remove('backdrop-show');
      el.classList.add('backdrop-hide');
      el.style.pointerEvents = 'none';
    });

    document.querySelectorAll('.cdk-overlay-backdrop').forEach(node => {
      const el = node as HTMLElement;
      el.classList.remove('cdk-overlay-backdrop-showing');
      el.style.pointerEvents = 'none';
      el.style.opacity = '0';
    });
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
    if (this.isQuoteLaneById(laneId)) {
      this.router.navigate(['/invoices/new'], {
        queryParams: { type: 'quote' }
      });
      return;
    }
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
    if (this.isQuoteLaneById(laneId)) {
      this.closeSearch();
      this.openQuoteBuilderForCustomer(c.id);
      return;
    }
    const isCompletedLane = this.isCompletedLaneById(laneId);
    const scheduledId = this.scheduledLaneId();
    const isScheduledLane = !!scheduledId && laneId === scheduledId;
    const hasCalendar = this.hasCalendarEvent(c.id);
    if (this.isScheduleRequiredLaneById(laneId) && !hasCalendar && !isCompletedLane && !isScheduledLane) {
      this.status.set('Calendar event required before moving to this lane.');
      this.closeSearch();
      this.openScheduleModal(c.id);
      return;
    }
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
              if (!this.hasFutureSchedule(c.id)) {
                this.status.set('Add appointment details for this scheduled customer.');
              }
              this.openScheduleModalDeferred(c.id);
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
        const scheduledId = this.scheduledLaneId();
        const isScheduledLane = !!scheduledId && laneId === scheduledId;
        const hasCalendar = this.hasCalendarEvent(cust.id);
        if (this.isScheduleRequiredLaneById(laneId) && !hasCalendar && !isCompletedLane && !isScheduledLane) {
          this.status.set('Calendar event required before moving to this lane.');
          this.openScheduleModal(cust.id);
          return;
        }
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
                  if (!this.hasFutureSchedule(cust.id)) {
                    this.status.set('Add appointment details for this scheduled customer.');
                  }
                  this.openScheduleModalDeferred(cust.id);
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
    this.deferInteractivityRestore(80);
    const map = { ...this.items() };
    const sourceId = event.previousContainer.id;
    const targetId = event.container.id;
    if (sourceId === targetId) {
      map[targetId] = [...map[targetId]].sort((a, b) => this.compareCreatedDesc(a, b));
      this.items.set(map);
      this.maybeInitializeSeenLeads(map);
      this.maybeInitializeSeenCards(map);
      this.maybeInitializeNotifiedLeads(map);
      this.maybeNotifyNewLeads(map);
      return;
    } else {
      const moved = map[sourceId][event.previousIndex];
      const movedCustomerId = (moved?.customerId || '').trim();
      const launchQuoteAfterMove = this.isQuoteLaneById(targetLaneId);
      if (launchQuoteAfterMove && !movedCustomerId) {
        this.status.set('Select a customer before creating a quote.');
        return;
      }
      const toCompleted = this.isCompletedLaneById(targetLaneId);
      const fromCompleted = this.isCompletedLaneById(sourceId);
      const scheduledId = this.scheduledLaneId();
      const isTargetScheduled = !!scheduledId && targetLaneId === scheduledId;
      if (movedCustomerId && this.isScheduleRequiredLaneById(targetLaneId) && !this.hasCalendarEvent(movedCustomerId)) {
        if (!toCompleted && !isTargetScheduled) {
          this.status.set('Calendar event required before moving to this lane.');
          this.openScheduleModal(movedCustomerId);
          return;
        }
      }
      const needsSchedulePrompt = !!(isTargetScheduled && movedCustomerId && !this.hasFutureSchedule(movedCustomerId));

      transferArrayItem(map[sourceId], map[targetId], event.previousIndex, event.currentIndex);
      this.items.set(map);
      this.maybeInitializeSeenLeads(map);
      this.maybeInitializeSeenCards(map);
      this.maybeInitializeNotifiedLeads(map);
      this.maybeNotifyNewLeads(map);
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
          this.maybeInitializeSeenLeads(map);
          this.maybeInitializeSeenCards(map);
          this.maybeInitializeNotifiedLeads(map);
          this.maybeNotifyNewLeads(map);
          if (needsCalendarOverride) {
            this.status.set('Moved to Completed. Click "No appointment required" to confirm override.');
          }
          if (needsSchedulePrompt && movedCustomerId) {
            this.status.set('Add appointment details for this scheduled customer.');
            this.openScheduleModalDeferred(movedCustomerId);
          }
          if (launchQuoteAfterMove && movedCustomerId) {
            this.openQuoteBuilderForCustomer(movedCustomerId);
            this.status.set('Opening quote builder');
          }
          if (movedCustomerId && toCompleted) {
            this.releaseActiveBayForCustomer(movedCustomerId, nowIso);
          } else if (movedCustomerId && fromCompleted && toInProgress) {
            this.reopenReleasedBayForCustomer(movedCustomerId);
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

  private openQuoteBuilderForCustomer(customerId: string): void {
    const id = String(customerId || '').trim();
    if (!id) return;
    const customer = this.customersMap()[id];
    const queryParams: Record<string, string> = {
      type: 'quote',
      customerId: id
    };
    if (customer) {
      queryParams['customerName'] = customer.name || '';
      queryParams['customerEmail'] = customer.email || '';
      queryParams['customerPhone'] = customer.phone || '';
      queryParams['customerVehicle'] = this.customerVehicleBasic(customer);
    }
    this.router.navigate(['/invoices/new'], { queryParams });
  }
}
