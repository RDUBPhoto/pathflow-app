import { UiInput } from '../../ui/controls';
import { UiIcon } from '../../ui/icons';
import { ToastController, UiModal, UiPopover } from '../../ui/overlays';
import { Component, signal, computed, effect, untracked, OnDestroy, HostListener, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import {
  CdkDropList, CdkDrag, CdkDragDrop,
  moveItemInArray
} from '@angular/cdk/drag-drop';
import { LanesApi, Lane } from '../../services/lanes-api.service';
import { WorkItemsApi, WorkItem, WorkClockAction, workItemDocumentRef } from '../../services/workitems-api.service';
import { CustomersApi, Customer } from '../../services/customers-api.service';
import { ScheduleApi, ScheduleItem } from '../../services/schedule-api.service';
import { SmsApiService } from '../../services/sms-api.service';
import { EmailApiService } from '../../services/email-api.service';
import { BusinessProfileService } from '../../services/business-profile.service';
import { InvoiceDetail, InvoiceDocumentType, InvoicesDataService } from '../../services/invoices-data.service';
import CustomerModalComponent from '../../components/customer/customer-modal/customer-modal.component';
import ScheduleModalComponent from '../../components/schedule/schedule-modal/schedule-modal.component';
import { UserMenuComponent } from '../../components/user/user-menu/user-menu.component';
import { CompanySwitcherComponent } from '../../components/header/company-switcher/company-switcher.component';
import { HttpClient } from '@angular/common/http';
import { UserScopedSettingsService } from '../../services/user-scoped-settings.service';
import { catchError, firstValueFrom, forkJoin, of, timeout } from 'rxjs';
import { InvoiceResponseApiService } from '../../services/invoice-response-api.service';
import { CustomerPortalApi } from '../../services/customer-portal-api.service';
import { QuoteResponseApiService } from '../../services/quote-response-api.service';
import { NotificationsApiService } from '../../services/notifications-api.service';
import { AuthService } from '../../auth/auth.service';
import { isExpiredCompletedCard } from './completed-card-visibility';
import { customerVehicles, vehicleSummary } from '../../utils/customer-vehicles';
import { DEFAULT_SHOP_TIME_ZONE, formatShopAppointment, shopCalendarIso, shopTimeMillis } from '../../utils/shop-time';

type ColorOpt = { label: string; hex: string };
type OnboardingStep = { selector: string; title: string; body: string };
const LANE_COLORS_SETTING_KEY = 'dashboard.laneColors';
const DASHBOARD_ONBOARDING_KEY = 'dashboard.onboarding.v1.completed';
const DASHBOARD_SEEN_LEADS_KEY = 'dashboard.leads.seen.v1';
const DASHBOARD_SEEN_CARDS_KEY = 'dashboard.cards.seen.v1';
const DASHBOARD_NOTIFIED_LEADS_KEY = 'dashboard.leads.notified.v1';
const DASHBOARD_DISMISSED_DOC_CARDS_KEY = 'dashboard.dismissedDocCards.v1';
const DASHBOARD_CARD_SEEN_KEY_SEPARATOR = '::';
const NOTIFICATION_OPENED_HINTS_KEY = 'pathflow.notifications.opened.v1';
const DASHBOARD_LOAD_TIMEOUT_MS = 25000;

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [
    CommonModule, FormsModule,
      UiInput, UiIcon, UiModal,
     UiPopover,
    CdkDropList, CdkDrag,
    CustomerModalComponent,
    ScheduleModalComponent,
    UserMenuComponent,
    CompanySwitcherComponent
  ],
  templateUrl: './dashboard.component.html',
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrls: ['./dashboard.component.scss']
})
export default class DashboardComponent implements OnDestroy {
  lanes = signal<Lane[]>([]);
  laneIds = computed(() => this.lanes().map(l => l.id));
  items = signal<Record<string, WorkItem[]>>({});
  customersMap = signal<Record<string, Customer>>({});
  allCustomers = signal<Customer[]>([]);
  scheduleItems = signal<ScheduleItem[]>([]);
  private readonly shopTimeZone = signal(DEFAULT_SHOP_TIME_ZONE);
  loading = signal(false);
  status = signal('');
  statusTone = computed(() => this.statusToastColor(this.status()));
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
  hiddenCardsOpen = signal(false);
  dashboardVisibilitySaving = signal(false);
  dashboardVisibilityError = signal('');
  readonly hiddenCards = computed(() => Object.values(this.items()).flat().filter(item => item.dashboardHidden));
  removeCustomerOpen = signal(false);
  removeCustomerItemId = signal<string | null>(null);
  customerModalInitialNotes = signal<string | null>(null);
  searchOpen = signal(false);
  searchLaneId = signal<string | null>(null);
  searchTerm = signal('');
  statusFading = signal(false);
  customerModalOpen = signal(false);
  customerModalId = signal<string | null>(null);
  customerModalMode = signal<'add' | 'edit' | 'lead'>('add');
  laneToLinkAfterSave = signal<string | null>(null);
  apiStatus = signal<'unknown' | 'up' | 'down'>('unknown');
  boardLoadError = signal('');
  scheduleModalOpen = signal(false);
  scheduleModalCustomerId = signal<string | null>(null);
  scheduleModalWorkItemId = signal<string | null>(null);
  phoneInquiry = signal('');
  private pendingPhoneInquiry = '';
  appointmentInfoModalOpen = signal(false);
  appointmentInfoItemId = signal<string | null>(null);
  appointmentInfoLaneId = signal<string | null>(null);
  appointmentInfoScheduleId = signal<string | null>(null);
  appointmentInfoSendEmail = signal(true);
  appointmentInfoSendSms = signal(true);
  appointmentInfoMessage = signal('');
  appointmentInfoSending = signal(false);
  appointmentInfoError = signal('');
  unreadActivityByCustomer = signal<Record<string, number>>({});
  unreadEmailByCustomer = signal<Record<string, number>>({});
  unreadSmsIdsByCustomer = signal<Record<string, string[]>>({});
  unreadEmailIdsByCustomer = signal<Record<string, string[]>>({});
  readonly invoiceDetails = computed(() => this.invoicesData.invoiceDetails());
  private readonly boardDocumentKey = computed(() => this.invoiceDetails()
    .map(doc => `${doc.id}|${doc.documentType}|${doc.stage}|${doc.sourceQuoteId || ''}`)
    .sort().join('\n'));
  private readonly convertedQuoteIds = computed(() => {
    const ids = new Set<string>();
    for (const doc of this.invoiceDetails()) {
      if (doc.documentType !== 'invoice' || doc.stage === 'canceled' || doc.stage === 'expired') continue;
      // Older converted invoices can still be linked by their deterministic ID.
      const source = doc.sourceQuoteId?.trim() ||
        (doc.id.startsWith('invoice-') ? doc.id.slice('invoice-'.length) : '');
      if (source) ids.add(source.toLowerCase());
    }
    return ids;
  });
  readonly documentSyncError = computed(() => this.invoicesData.documentSyncError());
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
    private businessProfile: BusinessProfileService,
    private invoicesData: InvoicesDataService,
    private invoiceResponseApi: InvoiceResponseApiService,
    private quoteResponseApi: QuoteResponseApiService,
    private customerPortal: CustomerPortalApi,
    private notificationsApi: NotificationsApiService,
    private auth: AuthService,
    private http: HttpClient,
    private userSettings: UserScopedSettingsService,
    private router: Router,
    private toastController: ToastController
  ) {

    this.updateResponsiveLayout();
    effect(() => {
      if (!this.invoicesData.documentSyncReady()) return;
      this.boardDocumentKey();
      // Shared documents can finish loading after the lanes and work items.
      if (this.hasLoadedBoard) untracked(() => this.loadAll());
    });
    effect(() => {
      this.userSettings.scope();
      this.loadLaneColors();
      this.loadSeenLeads();
      this.loadSeenCards();
      this.loadNotifiedLeads();
      this.loadDismissedDocCards();
    });
    this.apiCheckTimer = setInterval(() => this.checkApi(), 600000);
    this.unreadActivityTimer = setInterval(() => this.refreshUnreadActivity(), 5000);
    this.quoteResponseSyncTimer = setInterval(() => this.syncQuoteResponsesFromApi(), 10000);
    this.invoiceResponseSyncTimer = setInterval(() => this.syncInvoiceResponsesFromApi(), 10000);
    this.workClockTimer = setInterval(() => this.refreshWorkClocks(), 30000);

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
      const value = this.dismissedDocCardIds();
      if (!this.dismissedDocCardsLoaded || !this.dismissedDocCardsInitialized) return;
      if (this.dismissedDocCardsPersistTimer) clearTimeout(this.dismissedDocCardsPersistTimer);
      this.dismissedDocCardsPersistTimer = setTimeout(() => {
        const ids = Object.keys(value).filter(Boolean);
        this.userSettings.setValue(DASHBOARD_DISMISSED_DOC_CARDS_KEY, {
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

    effect(() => {
      const initialized = this.auth.initialized();
      const isAuthenticated = this.auth.isAuthenticated();
      const user = this.auth.user();
      const locationKey = [
        this.auth.defaultLocationId(),
        ...this.auth.locations().map(location => location.id)
      ].filter(Boolean).join('|');

      if (!initialized || !isAuthenticated) {
        this.loadAllGeneration++;
        this.authLoadSignature = '';
        this.hasLoadedBoard = false;
        this.lanes.set([]);
        this.items.set({});
        this.boardLoadError.set('');
        this.apiStatus.set('unknown');
        return;
      }

      const signature = [
        user?.id || user?.email || 'user',
        locationKey || 'location'
      ].join(DASHBOARD_CARD_SEEN_KEY_SEPARATOR);
      if (this.authLoadSignature === signature) return;
      this.loadAllGeneration++;
      this.authLoadSignature = signature;
      this.hasLoadedBoard = false;
      this.lanes.set([]);
      this.items.set({});
      this.boardLoadError.set('');

      this.loadAll();
      this.checkApi();
      this.refreshUnreadActivity();
      this.maybeStartOnboarding();
      this.syncQuoteResponsesFromApi();
      this.syncInvoiceResponsesFromApi();
    });
  }

  private statusTimer: any = null;
  private statusFadeTimer: any = null;
  private apiCheckTimer: any = null;
  private unreadActivityTimer: any = null;
  private quoteResponseSyncTimer: any = null;
  private invoiceResponseSyncTimer: any = null;
  private workClockTimer: ReturnType<typeof setInterval> | null = null;
  private laneColorPersistTimer: any = null;
  private laneColorsLoadToken = 0;
  private laneColorsLoaded = false;
  private authLoadSignature = '';
  private hasLoadedBoard = false;
  private loadAllRetryTimer: any = null;
  private loadAllGeneration = 0;
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
  private readonly invoicePaidResponseNoticeKeys = new Set<string>();
  private dismissedDocCardsPersistTimer: any = null;
  private dismissedDocCardsLoadToken = 0;
  private dismissedDocCardsLoaded = false;
  private dismissedDocCardsInitialized = false;
  private interactivityRestoreTimer: any = null;
  private lastToastMessage = '';
  private lastToastAt = 0;
  seenLeadIds = signal<Record<string, true>>({});
  seenCardIds = signal<Record<string, true>>({});
  notifiedLeadIds = signal<Record<string, true>>({});
  dismissedDocCardIds = signal<Record<string, true>>({});

  private async presentStatusToast(message: string): Promise<void> {
    const value = String(message || '').trim();
    if (!value) return;
    const now = Date.now();
    if (this.lastToastMessage === value && now - this.lastToastAt < 1200) return;
    this.lastToastMessage = value;
    this.lastToastAt = now;
    const color = this.statusToastColor(value);
    const toast = await this.toastController.create({
      message: value,
      color,
      duration: 1700,
      position: 'top'
    });
    await toast.present();
  }

  private statusToastColor(message: string): 'danger' | 'success' {
    const value = String(message || '').trim().toLowerCase();
    if (/^(added|moved) to completed\. click "no appointment required"/.test(value)) return 'success';
    return /\b(error|failed|failure|timeout|timed out|missing|cannot|invalid|unavailable|unable|expired|blocked|denied|conflict|required|not|unauthorized|forbidden)\b|\b(could not|went wrong)\b|^no\b|^select a customer\b|^final invoice is available after\b/.test(value)
      ? 'danger'
      : 'success';
  }

  ngOnDestroy() {
    this.loadAllGeneration++;
    if (this.apiCheckTimer) { clearInterval(this.apiCheckTimer); this.apiCheckTimer = null; }
    if (this.unreadActivityTimer) { clearInterval(this.unreadActivityTimer); this.unreadActivityTimer = null; }
    if (this.quoteResponseSyncTimer) { clearInterval(this.quoteResponseSyncTimer); this.quoteResponseSyncTimer = null; }
    if (this.invoiceResponseSyncTimer) { clearInterval(this.invoiceResponseSyncTimer); this.invoiceResponseSyncTimer = null; }
    if (this.workClockTimer) clearInterval(this.workClockTimer);
    if (this.laneColorPersistTimer) { clearTimeout(this.laneColorPersistTimer); this.laneColorPersistTimer = null; }
    if (this.seenLeadsPersistTimer) { clearTimeout(this.seenLeadsPersistTimer); this.seenLeadsPersistTimer = null; }
    if (this.seenCardsPersistTimer) { clearTimeout(this.seenCardsPersistTimer); this.seenCardsPersistTimer = null; }
    if (this.notifiedLeadsPersistTimer) { clearTimeout(this.notifiedLeadsPersistTimer); this.notifiedLeadsPersistTimer = null; }
    if (this.interactivityRestoreTimer) { clearTimeout(this.interactivityRestoreTimer); this.interactivityRestoreTimer = null; }
    if (this.loadAllRetryTimer) { clearTimeout(this.loadAllRetryTimer); this.loadAllRetryTimer = null; }
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
    if (!this.auth.isAuthenticated()) {
      this.apiStatus.set('unknown');
      return;
    }
    this.http.get<{ ok: boolean }>('/api/ping').subscribe({
      next: () => this.apiStatus.set('up'),
      error: () => this.apiStatus.set('down')
    });
  }

  private refreshUnreadActivity(): void {
    if (!this.auth.isAuthenticated()) {
      this.unreadActivityByCustomer.set({});
      this.unreadEmailByCustomer.set({});
      this.unreadSmsIdsByCustomer.set({});
      this.unreadEmailIdsByCustomer.set({});
      return;
    }
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
        this.status.set('Appointment override saved');
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
    if (customerId && !this.hasCalendarEventForItem(it)) {
      this.status.set('Calendar event required before check-in.');
      this.openScheduleModal(customerId, it.jobId ? it.id : null);
      return;
    }

    const checkedInAt = new Date().toISOString();
    this.status.set('Checking in customer');
    this.itemsApi.update({
      id: it.id,
      laneId: inProgressLaneId,
      workClockAction: 'check-in',
      checkedInAt,
      completedAt: '',
      calendarOverrideAt: '',
      isPaused: false,
      pausedAt: '',
      lastWorkResumedAt: '',
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
            lastWorkResumedAt: '',
            workClockState: 'not-started',
            activeWorkDurationMs: 0,
            workDurationMs: this.safeDuration(it.workDurationMs),
            pauseDurationMs: this.safeDuration(it.pauseDurationMs)
          });
          next[inProgressLaneId] = target;
          return next;
        });
        this.markCardSeenForLaneId(it, inProgressLaneId);
        this.status.set('Checked in');
      },
      error: err => this.status.set(this.extractApiError(err, 'Check-in failed'))
    });
  }

  workClockAction(item: WorkItem): Exclude<WorkClockAction, 'check-in'> {
    if (item.workClockState === 'paused') return 'resume';
    return item.workClockState === 'not-started' ? 'start' : 'pause';
  }

  workClockLabel(item: WorkItem): string {
    const minutes = Math.floor(Number(item.activeWorkDurationMs || 0) / 60000);
    const time = `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    const state = item.workClockState;
    if (state === 'not-started') return 'Checked in · Work has not started';
    if (state === 'after-hours') return `Shop closed · ${time} worked`;
    if (state === 'paused') return `Paused · ${time} worked`;
    return `Working · ${time} tracked`;
  }

  updateWorkClock(item: WorkItem, event: Event): void {
    event.stopPropagation();
    this.itemsApi.update({ id: item.id, workClockAction: this.workClockAction(item) }).subscribe({
      next: () => this.refreshWorkClocks(),
      error: error => this.status.set(this.extractApiError(error, 'Could not update work clock'))
    });
  }

  private refreshWorkClocks(): void {
    if (!Object.values(this.items()).some(rows => rows.some(item => item.checkedInAt && !item.completedAt))) return;
    const generation = this.loadAllGeneration;
    this.itemsApi.list().pipe(timeout(DASHBOARD_LOAD_TIMEOUT_MS)).subscribe({
      next: rows => {
        if (this.loadAllGeneration !== generation) return;
        const byId = new Map(rows.map(row => [row.id, row]));
        this.items.update(current => Object.fromEntries(Object.entries(current).map(([lane, items]) => [
          lane, items.map(item => {
            const row = byId.get(item.id);
            if (!item.checkedInAt || !row || row.laneId !== item.laneId) return item;
            return { ...item, workClockState: row.workClockState, activeWorkDurationMs: row.activeWorkDurationMs,
              checkedInAt: row.checkedInAt, isPaused: row.isPaused, pausedAt: row.pausedAt,
              lastWorkResumedAt: row.lastWorkResumedAt, workDurationMs: row.workDurationMs, pauseDurationMs: row.pauseDurationMs };
          })
        ])));
      },
      error: () => {}
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
      error: err => this.status.set(this.extractApiError(err, 'Revert check-in failed'))
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

    const notes = this.notesListOf(it);
    this.customerModalInitialNotes.set(notes.length ? notes.join('\n') : null);

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

  cardRemoveLabel(): string {
    const item = this.findItemById(this.cardMenuItemId());
    if (item?.jobId) return 'Hide from dashboard';
    const lane = this.laneForItem(item);
    if (this.isWorkflowStatusLane(lane)) return 'Remove card';
    return 'Remove from lane';
  }

  hiddenCardReference(item: WorkItem): string {
    const invoice = this.invoicesData.getInvoiceById(workItemDocumentRef(item));
    return invoice?.invoiceNumber || this.laneForItem(item)?.name || '';
  }

  setCardDashboardHidden(item: WorkItem, dashboardHidden: boolean): void {
    if (this.dashboardVisibilitySaving()) return;
    this.dashboardVisibilitySaving.set(true);
    this.dashboardVisibilityError.set('');
    this.itemsApi.setDashboardHidden(item.id, dashboardHidden).subscribe({
      next: response => {
        if (response.ok) {
          this.items.update(lanes => Object.fromEntries(Object.entries(lanes).map(([laneId, cards]) => [
            laneId, cards.map(card => card.id === item.id ? { ...card, dashboardHidden } : card)
          ])));
          this.status.set(dashboardHidden ? 'Card hidden from dashboard' : 'Card restored to dashboard');
        } else {
          this.dashboardVisibilityError.set('Could not change card visibility.');
          this.status.set('Could not change card visibility.');
        }
        this.dashboardVisibilitySaving.set(false);
      },
      error: () => {
        this.dashboardVisibilitySaving.set(false);
        this.dashboardVisibilityError.set('Could not change card visibility.');
        this.status.set('Could not change card visibility.');
      }
    });
  }

  removeCustomerWarningMessage(): string {
    const item = this.findItemById(this.removeCustomerItemId());
    const doc = item ? this.invoicesData.getInvoiceById(workItemDocumentRef(item)) : null;
    if (doc && this.isCancelableDocumentForRemoval(doc)) {
      return `Remove this card and cancel ${doc.invoiceNumber}?`;
    }
    return 'Remove this card from the workflow?';
  }

  removeCardAction() {
    const item = this.findItemById(this.cardMenuItemId());
    this.cardMenuOpen.set(false);
    if (!item) return;

    if (item.jobId) {
      this.setCardDashboardHidden(item, true);
      return;
    }
    const lane = this.laneForItem(item);
    if (!this.isWorkflowStatusLane(lane)) {
      this.removeCardFromLaneById(item.id);
      return;
    }

    this.removeCustomerItemId.set(item.id);
    this.removeCustomerOpen.set(true);
  }

  cancelRemoveCustomer() {
    this.removeCustomerOpen.set(false);
    this.removeCustomerItemId.set(null);
  }

  confirmRemoveCustomer() {
    const item = this.findItemById(this.removeCustomerItemId());
    const doc = item ? this.invoicesData.getInvoiceById(workItemDocumentRef(item)) : null;
    this.cancelRemoveCustomer();
    if (!item || item.jobId) return;
    const customerId = String(item.customerId || '');
    const targetItemIds = [item.id];
    const dismissedDocKeys = this.dismissedDocKeysForItems(targetItemIds);

    this.status.set('Removing card');
    const snapshot = this.removeItemsLocally(targetItemIds);

    const deleteWorkItem = () => {
      if (!targetItemIds.length) {
        this.status.set('Card removed');
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
          if (doc && this.isCancelableDocumentForRemoval(doc)) {
            this.invoicesData.setStage(doc.id, 'canceled', 'Removed from dashboard workflow.');
            void this.sendCancellationEmailsForDocuments([doc], customerId);
          }
          if (dismissedDocKeys.length) {
            this.markDocumentCardsDismissed(dismissedDocKeys);
          }
          this.status.set('Card removed');
        },
        error: () => {
          this.items.set(snapshot);
          this.status.set('Remove error');
          this.loadAll();
        }
      });
    };

    deleteWorkItem();
  }

  private futureScheduleIdsForCustomer(customerId: string, workItemId?: string): string[] {
    const id = String(customerId || '').trim();
    if (!id) return [];
    const now = Date.now();
    return this.scheduleItems()
      .filter(entry => {
        if (String(entry.customerId || '').trim() !== id || (entry.workItemId || undefined) !== workItemId) return false;
        if (!entry.start) return false;
        const startMs = this.scheduleMillis(entry.start);
        return Number.isFinite(startMs) && startMs >= now;
      })
      .map(entry => String(entry.id || '').trim())
      .filter(Boolean);
  }

  private deleteFutureAppointmentsForCustomer(customerId: string, workItemId?: string): void {
    const scheduleIds = this.futureScheduleIdsForCustomer(customerId, workItemId);
    if (!scheduleIds.length) return;
    const confirmed = window.confirm('This customer has a future appointment on the calendar. Delete the appointment too?');
    if (!confirmed) {
      this.status.set('Appointment kept on calendar.');
      return;
    }
    const deletes = scheduleIds.map(id =>
      this.scheduleApi.delete(id).pipe(catchError(() => of({ ok: false })))
    );
    forkJoin(deletes).subscribe({
      next: results => {
        this.scheduleItems.update(rows => (rows || []).filter(row => !scheduleIds.includes(String(row.id || '').trim())));
        const failed = results.some(result => !result?.ok);
        this.status.set(failed ? 'Moved, but could not delete every appointment.' : 'Moved and appointment deleted.');
      },
      error: () => this.status.set('Moved, but could not delete appointment.')
    });
  }

  private isCancelableDocumentForRemoval(doc: InvoiceDetail): boolean {
    if (doc.stage === 'canceled' || doc.stage === 'expired') return false;
    if (doc.documentType === 'invoice' && (Number(doc.paidAmount) > 0 || doc.stage === 'accepted' || doc.stage === 'completed')) return false;
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
    if (!this.hasCustomerFacingEmailHistory(doc)) return false;
    if (doc.documentType === 'invoice') {
      // Only notify invoice cancellation if the invoice had already been sent.
      return stage === 'sent';
    }
    // Quotes may be customer-visible across sent/accepted/declined.
    return stage === 'sent' || stage === 'accepted' || stage === 'declined';
  }

  private hasCustomerFacingEmailHistory(doc: Pick<InvoiceDetail, 'documentType' | 'timeline'> | null | undefined): boolean {
    if (!doc) return false;
    const isQuote = doc.documentType === 'quote';
    const timeline = Array.isArray(doc.timeline) ? doc.timeline : [];
    return timeline.some(entry => {
      const text = String(entry?.message || '').trim().toLowerCase();
      if (!text) return false;
      const hasEmailSignal = text.includes('email') || text.includes('e-mail') || text.includes('emailed');
      const hasSentSignal = text.includes('sent') || text.includes('delivered');
      const hasDocSignal = isQuote
        ? text.includes('quote')
        : (text.includes('invoice') || text.includes('final invoice'));
      if (hasEmailSignal && hasSentSignal && hasDocSignal) return true;
      return hasDocSignal && text.includes('sent to customer');
    });
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

  loadDismissedDocCards() {
    this.dismissedDocCardsLoaded = false;
    this.dismissedDocCardsInitialized = false;
    const token = ++this.dismissedDocCardsLoadToken;
    this.userSettings.getValue<{ initialized?: boolean; ids?: string[] }>(DASHBOARD_DISMISSED_DOC_CARDS_KEY).subscribe({
      next: value => {
        if (token !== this.dismissedDocCardsLoadToken) return;
        const normalized = this.normalizeSeenLeads(value);
        this.dismissedDocCardIds.set(normalized.ids);
        this.dismissedDocCardsInitialized = normalized.initialized;
        this.dismissedDocCardsLoaded = true;
      },
      error: () => {
        if (token !== this.dismissedDocCardsLoadToken) return;
        this.dismissedDocCardIds.set({});
        this.dismissedDocCardsInitialized = false;
        this.dismissedDocCardsLoaded = true;
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
        this.notifiedLeadIds.update(current => ({ ...current, [itemId]: true }));
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

  loadAll(retryAttempt = 0) {
    if (!this.auth.initialized() || !this.auth.isAuthenticated()) {
      this.loadAllGeneration++;
      this.loading.set(false);
      return;
    }
    const generation = ++this.loadAllGeneration;
    if (this.loadAllRetryTimer) {
      clearTimeout(this.loadAllRetryTimer);
      this.loadAllRetryTimer = null;
    }
    let hadLoadError = false;
    // Refreshes should not make an already-rendered board look like it is reloading.
    if (!this.hasLoadedBoard) this.loading.set(true);
    forkJoin({
      customers: this.customersApi.list().pipe(
        timeout(DASHBOARD_LOAD_TIMEOUT_MS),
        catchError((error: unknown) => {
          if (generation !== this.loadAllGeneration) return of(null);
          hadLoadError = true;
          this.status.set(this.dashboardLoadError('customers', error));
          return of(null as Customer[] | null);
        })
      ),
      shopTimeZone: this.scheduleApi.getShopTimeZone().pipe(
        timeout(DASHBOARD_LOAD_TIMEOUT_MS),
        catchError(() => of(DEFAULT_SHOP_TIME_ZONE))
      ),
      schedule: this.scheduleApi.list().pipe(
        timeout(DASHBOARD_LOAD_TIMEOUT_MS),
        catchError((error: unknown) => {
          if (generation !== this.loadAllGeneration) return of(null);
          hadLoadError = true;
          this.status.set(this.dashboardLoadError('schedule', error));
          return of(null as ScheduleItem[] | null);
        })
      ),
      lanes: this.lanesApi.list().pipe(
        timeout(DASHBOARD_LOAD_TIMEOUT_MS),
        catchError((error: unknown) => {
          if (generation !== this.loadAllGeneration) return of(null);
          hadLoadError = true;
          this.status.set(this.dashboardLoadError('lanes', error));
          return of(null as Lane[] | null);
        })
      ),
      items: this.itemsApi.list().pipe(
        timeout(DASHBOARD_LOAD_TIMEOUT_MS),
        catchError((error: unknown) => {
          if (generation !== this.loadAllGeneration) return of(null);
          hadLoadError = true;
          this.status.set(this.dashboardLoadError('items', error));
          return of(null as WorkItem[] | null);
        })
      )
    }).subscribe({
      next: ({ customers, schedule, shopTimeZone, lanes, items }) => {
        if (generation !== this.loadAllGeneration) return;
        if (customers !== null) {
          const m: Record<string, Customer> = {};
          for (const c of customers) m[c.id] = c;
          this.customersMap.set(m);
          this.allCustomers.set(customers);
        }
        this.shopTimeZone.set(shopTimeZone);
        if (schedule !== null) this.scheduleItems.set(schedule);
        // A failed fetch is not an empty board. Keep the last good lanes/items
        // and never run destructive reconciliation on an incomplete response.
        if (lanes === null || items === null) {
          this.boardLoadError.set(this.hasLoadedBoard
            ? 'Dashboard refresh failed. Showing the last loaded board while retrying.'
            : 'Dashboard could not load. Retrying automatically; you can retry now.');
          this.loading.set(false);
          if (this.auth.initialized() && this.auth.isAuthenticated()) {
            this.scheduleDashboardLoadRetry(retryAttempt + 1);
          }
          return;
        }
        this.boardLoadError.set('');
        this.lanes.set(lanes);

        const map: Record<string, WorkItem[]> = {};
        for (const l of lanes || []) map[l.id] = [];
        for (const r of items || []) {
          if (!map[r.laneId]) map[r.laneId] = [];
          map[r.laneId].push({ ...r, customerId: r.customerId ?? '' });
        }
        for (const id of Object.keys(map)) map[id].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
        this.items.set(map);
        this.hasLoadedBoard = true;

        if (hadLoadError) {
          // Show any successfully loaded cards, but do not reconcile or write
          // based on missing customers or appointments from a partial load.
          this.boardLoadError.set('Some dashboard data could not load. Showing available data; retrying.');
          this.loading.set(false);
          this.scheduleDashboardLoadRetry(retryAttempt + 1);
          return;
        }

        if (!this.invoicesData.documentSyncReady()) {
          this.loading.set(false);
          return;
        }
        const pruned = this.pruneDuplicateDocumentCards(map, lanes || []);
        if (pruned) {
          this.loading.set(false);
          return;
        }
        const seeded = this.ensureDocumentCardsExist(map, lanes || []);
        if (seeded) {
          this.loading.set(false);
          return;
        }

        this.maybeInitializeSeenLeads(map);
        this.maybeInitializeSeenCards(map);
        this.maybeInitializeNotifiedLeads(map);
        this.maybeNotifyNewLeads(map);
        this.applyOpenedNotificationSeenHints(map);
        this.syncScheduledLane();
        this.syncInvoiceResponsesFromApi();
        this.loading.set(false);
      },
      error: () => {
        if (generation !== this.loadAllGeneration) return;
        this.status.set('Load dashboard error');
        this.boardLoadError.set(this.hasLoadedBoard
          ? 'Dashboard refresh failed. Showing the last loaded board while retrying.'
          : 'Dashboard could not load. Retrying automatically; you can retry now.');
        this.loading.set(false);
        if (this.auth.initialized() && this.auth.isAuthenticated()) {
          this.scheduleDashboardLoadRetry(retryAttempt + 1);
        }
      }
    });
  }

  private dashboardLoadError(resource: string, error: unknown): string {
    return `Load ${resource} ${error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'failed'}`;
  }

  private scheduleDashboardLoadRetry(nextAttempt: number): void {
    if (this.loadAllRetryTimer) clearTimeout(this.loadAllRetryTimer);
    const delay = nextAttempt === 1 ? 750 : Math.min(30000, 1200 * Math.pow(2, Math.min(nextAttempt - 2, 5)));
    this.loadAllRetryTimer = setTimeout(() => {
      this.loadAllRetryTimer = null;
      this.loadAll(nextAttempt);
    }, delay);
  }

  private ensureDocumentCardsExist(map: Record<string, WorkItem[]>, lanes: Lane[]): boolean {
    const quoteLane = lanes.find(lane => this.laneStageKey(lane) === 'quote') || null;
    const invoicedLane = lanes.find(lane => this.laneStageKey(lane) === 'invoiced') || null;
    if (!quoteLane && !invoicedLane) return false;

    const laneById = new Map<string, Lane>((lanes || []).map(lane => [String(lane.id || '').trim(), lane]));
    const existingByLaneAndDocument = new Set<string>();
    const hiddenDocumentRefs = new Set<string>();
    const workflowInvoiceIds = new Set<string>();
    for (const [laneId, rows] of Object.entries(map || {})) {
      const lane = laneById.get(String(laneId || '').trim()) || null;
      if (!lane) continue;
      const stage = this.laneStageKey(lane);
      for (const row of rows || []) {
        const reference = workItemDocumentRef(row);
        if (row.dashboardHidden) hiddenDocumentRefs.add(reference.toLowerCase());
        if (reference && ['scheduled', 'inprogress', 'completed'].includes(stage)) {
          const invoice = this.invoicesData.getInvoiceById(reference);
          if (invoice?.documentType === 'invoice') workflowInvoiceIds.add(invoice.id);
        }
        const docRef = this.resolvedDocumentRefForLaneCard(row, lane);
        if (!docRef) continue;
        existingByLaneAndDocument.add(`${laneId.toLowerCase()}::${docRef.toLowerCase()}`);
      }
    }
    const toCreate: Array<{ laneId: string; customerId: string; title: string }> = [];
    const seenCreateKeys = new Set<string>();

    for (const doc of this.invoiceDetails()) {
      if (!this.isDocumentActiveOnBoard(doc)) continue;
      const targetLaneId =
        doc.documentType === 'quote'
          ? (quoteLane?.id || '')
          : (invoicedLane?.id || '');
      if (!targetLaneId) continue;

      const docRef = String(doc.id || doc.invoiceNumber || '').trim();
      if (!docRef || hiddenDocumentRefs.has(docRef.toLowerCase())) continue;
      const laneDocKey = `${targetLaneId.toLowerCase()}::${docRef.toLowerCase()}`;
      if (existingByLaneAndDocument.has(laneDocKey)) continue;
      if (seenCreateKeys.has(laneDocKey)) continue;
      if (this.dismissedDocCardIds()[laneDocKey]) continue;
      const customerId = this.customerIdForDocument(doc);
      if (doc.documentType === 'invoice' && workflowInvoiceIds.has(doc.id)) continue;

      seenCreateKeys.add(laneDocKey);
      toCreate.push({
        laneId: targetLaneId,
        customerId,
        title: this.cardTitleForDocument(doc)
      });
    }

    if (!toCreate.length) return false;
    this.createMissingDocumentCards(toCreate);
    return true;
  }

  private dismissedDocKeysForItems(itemIds: string[]): string[] {
    const ids = new Set((itemIds || []).map(id => String(id || '').trim()).filter(Boolean));
    if (!ids.size) return [];
    const laneById = new Map<string, Lane>((this.lanes() || []).map(lane => [String(lane.id || '').trim(), lane]));
    const out = new Set<string>();

    for (const [laneId, rows] of Object.entries(this.items() || {})) {
      const lane = laneById.get(String(laneId || '').trim()) || null;
      if (!lane) continue;
      const stage = this.laneStageKey(lane);
      if (stage !== 'quote' && stage !== 'invoiced') continue;
      for (const row of rows || []) {
        const rowId = String(row.id || '').trim();
        if (!ids.has(rowId)) continue;
        const ref = String(this.resolvedDocumentRefForLaneCard(row, lane) || '').trim().toLowerCase();
        if (!ref) continue;
        out.add(`${String(laneId || '').trim().toLowerCase()}::${ref}`);
      }
    }

    return Array.from(out);
  }

  private markDocumentCardsDismissed(keys: string[]): void {
    if (!keys.length) return;
    this.dismissedDocCardsInitialized = true;
    const next = { ...this.dismissedDocCardIds() };
    for (const raw of keys) {
      const key = String(raw || '').trim().toLowerCase();
      if (!key) continue;
      next[key] = true;
    }
    this.dismissedDocCardIds.set(next);
  }

  private pruneDuplicateDocumentCards(map: Record<string, WorkItem[]>, lanes: Lane[]): boolean {
    const duplicatesToDelete = [
      ...this.pruneDuplicateDocumentCardsInMap(map, lanes),
      ...this.pruneWorkflowLaneDuplicatesInMap(map, lanes),
      ...this.pruneLifecycleStageDuplicatesInMap(map, lanes)
    ];
    if (!duplicatesToDelete.length) return false;
    this.deleteDuplicateDocumentCards(Array.from(new Set(duplicatesToDelete)));
    return true;
  }

  private pruneDuplicateDocumentCardsInMap(map: Record<string, WorkItem[]>, lanes: Lane[]): string[] {
    const duplicatesToDelete: string[] = [];

    for (const lane of lanes || []) {
      const stage = this.laneStageKey(lane);
      if (stage !== 'quote' && stage !== 'invoiced') continue;

      const rows = [...(map[lane.id] || [])];
      if (!rows.length) continue;
      const byDocument = new Map<string, WorkItem[]>();
      for (const row of rows) {
        const resolvedRef = String(this.resolvedDocumentRefForLaneCard(row, lane) || '').trim().toLowerCase();
        if (!resolvedRef) continue;
        const list = byDocument.get(resolvedRef) || [];
        list.push(row);
        byDocument.set(resolvedRef, list);
      }

      const removeIds = new Set<string>();
      for (const group of byDocument.values()) {
        if (group.length <= 1) continue;
        const ordered = group
          .slice()
          .sort((a, b) => this.asMillis(String(b.updatedAt || b.createdAt || '')) - this.asMillis(String(a.updatedAt || a.createdAt || '')));
        const keepId = String(ordered[0].id || '').trim();
        for (const row of ordered.slice(1)) {
          if (row.dashboardHidden) continue;
          const id = String(row.id || '').trim();
          if (!id || id === keepId) continue;
          removeIds.add(id);
          duplicatesToDelete.push(id);
        }
      }

      if (removeIds.size) {
        map[lane.id] = rows.filter(row => !removeIds.has(String(row.id || '').trim()));
      }
    }

    return Array.from(new Set(duplicatesToDelete));
  }

  private workflowCustomerKey(item: WorkItem): string {
    const reference = item.jobId || workItemDocumentRef(item);
    if (reference) return `document:${reference}`;
    if (['phone', 'sms', 'web'].includes(String(item.leadSource || item.source || ''))) return `lead:${item.id}`;
    const customerId = String(item.customerId || '').trim();
    if (customerId) return `id:${customerId.toLowerCase()}`;
    const inferred = this.inferredCustomerIdFromItem(item);
    if (inferred) return `id:${inferred.toLowerCase()}`;
    const name = String(this.customerName(item) || '').trim().toLowerCase();
    const vehicle = String(this.vehicleOf(item) || '').trim().toLowerCase();
    if (!name && !vehicle) return '';
    return `name:${name}|vehicle:${vehicle}`;
  }

  private pruneWorkflowLaneDuplicatesInMap(map: Record<string, WorkItem[]>, lanes: Lane[]): string[] {
    const duplicatesToDelete: string[] = [];
    for (const lane of lanes || []) {
      const stage = this.laneStageKey(lane);
      if (stage !== 'scheduled' && stage !== 'inprogress') continue;
      const rows = [...(map[lane.id] || [])];
      if (rows.length <= 1) continue;
      const byKey = new Map<string, WorkItem[]>();
      for (const row of rows) {
        const key = this.workflowCustomerKey(row);
        if (!key) continue;
        const list = byKey.get(key) || [];
        list.push(row);
        byKey.set(key, list);
      }
      const removeIds = new Set<string>();
      for (const group of byKey.values()) {
        if (group.length <= 1) continue;
        const ordered = group
          .slice()
          .sort((a, b) => this.asMillis(String(b.updatedAt || b.createdAt || '')) - this.asMillis(String(a.updatedAt || a.createdAt || '')));
        const keepId = String(ordered[0].id || '').trim();
        for (const row of ordered.slice(1)) {
          if (row.dashboardHidden) continue;
          const id = String(row.id || '').trim();
          if (!id || id === keepId) continue;
          removeIds.add(id);
          duplicatesToDelete.push(id);
        }
      }
      if (removeIds.size) {
        map[lane.id] = rows.filter(row => !removeIds.has(String(row.id || '').trim()));
      }
    }
    return Array.from(new Set(duplicatesToDelete));
  }

  private lifecycleStagePriority(stage: string): number {
    if (stage === 'completed') return 60;
    if (stage === 'inprogress') return 50;
    if (stage === 'scheduled') return 40;
    if (stage === 'invoiced') return 30;
    if (stage === 'quote') return 20;
    if (stage === 'lead') return 10;
    return 0;
  }

  private isWebLeadCard(row: WorkItem, laneStage: string): boolean {
    if (laneStage !== 'lead') return false;
    const source = String((row as any).source || '').trim().toLowerCase();
    const leadSource = String((row as any).leadSource || '').trim().toLowerCase();
    const channel = String((row as any).channel || '').trim().toLowerCase();
    return source === 'web' || leadSource === 'web' || channel === 'website';
  }

  private pruneLifecycleStageDuplicatesInMap(map: Record<string, WorkItem[]>, lanes: Lane[]): string[] {
    const laneById = new Map<string, Lane>(
      (lanes || []).map(lane => [String(lane.id || '').trim(), lane])
    );
    const workflowRows: Array<{ laneId: string; laneStage: string; row: WorkItem }> = [];
    for (const [laneId, rows] of Object.entries(map || {})) {
      const lane = laneById.get(String(laneId || '').trim()) || null;
      const stage = this.laneStageKey(lane);
      if (!this.workflowLaneStage(stage)) continue;
      for (const row of rows || []) workflowRows.push({ laneId, laneStage: stage, row });
    }

    const byDocument = new Map<string, Array<{ laneId: string; laneStage: string; row: WorkItem }>>();
    for (const entry of workflowRows) {
      const lane = laneById.get(entry.laneId) || null;
      if (!lane) continue;
      const documentRef = String(this.resolvedDocumentRefForLaneCard(entry.row, lane) || '').trim().toLowerCase();
      if (!documentRef) continue;
      // A customer can have multiple jobs over time. Never delete one quote just
      // because an unrelated older job reached a later workflow stage.
      const key = `${this.workflowCustomerKey(entry.row)}|doc:${documentRef}`;
      const list = byDocument.get(key) || [];
      list.push(entry);
      byDocument.set(key, list);
    }

    const removeIds = new Set<string>();
    for (const entries of byDocument.values()) {
      if (entries.length <= 1) continue;
      entries.sort((a, b) => {
        const stageDiff = this.lifecycleStagePriority(b.laneStage) - this.lifecycleStagePriority(a.laneStage);
        if (stageDiff !== 0) return stageDiff;
        return this.asMillis(String(b.row.updatedAt || b.row.createdAt || ''))
          - this.asMillis(String(a.row.updatedAt || a.row.createdAt || ''));
      });
      const keeperId = String(entries[0].row.id || '').trim();
      for (const entry of entries.slice(1)) {
        if (entry.row.dashboardHidden || this.isWebLeadCard(entry.row, entry.laneStage)) continue;
        const id = String(entry.row.id || '').trim();
        if (!id || id === keeperId) continue;
        removeIds.add(id);
      }
    }

    if (!removeIds.size) return [];
    for (const [laneId, rows] of Object.entries(map || {})) {
      map[laneId] = (rows || []).filter(row => !removeIds.has(String(row.id || '').trim()));
    }
    return Array.from(removeIds);
  }

  private deleteDuplicateDocumentCards(ids: string[]): void {
    let index = 0;
    const next = () => {
      if (index >= ids.length) {
        this.loadAll();
        return;
      }
      const id = String(ids[index++] || '').trim();
      if (!id) {
        next();
        return;
      }
      this.itemsApi.delete(id).subscribe({
        next: () => next(),
        error: () => next()
      });
    };
    next();
  }

  private createMissingDocumentCards(
    pending: Array<{ laneId: string; customerId: string; title: string }>
  ): void {
    let index = 0;
    const createNext = () => {
      if (index >= pending.length) {
        this.loadAll();
        return;
      }

      const row = pending[index++];
      this.itemsApi.create(row.title, row.laneId).subscribe({
        next: created => {
          if (!row.customerId) {
            createNext();
            return;
          }
          this.itemsApi.update({ id: created.id, customerId: row.customerId }).subscribe({
            next: () => createNext(),
            error: () => createNext()
          });
        },
        error: () => createNext()
      });
    };
    createNext();
  }

  private customerIdForDocument(doc: InvoiceDetail): string {
    const direct = String(doc.customerId || '').trim();
    if (direct) return direct;
    const docEmail = String(doc.customerEmail || '').trim().toLowerCase();
    if (!docEmail) return '';
    const matchingCustomers = this.allCustomers().filter(customer =>
      [customer.email, customer.secondaryEmail].some(email => email?.trim().toLowerCase() === docEmail)
    );
    return matchingCustomers.length === 1 ? matchingCustomers[0].id : '';
  }

  private cardTitleForDocument(doc: InvoiceDetail): string {
    const name = String(doc.customerName || '').trim() || 'Customer';
    const vehicle = String(doc.vehicle || '').trim();
    const number = String(doc.invoiceNumber || '').trim() || (doc.documentType === 'invoice' ? 'Invoice' : 'Quote');
    const ref = String(doc.id || doc.invoiceNumber || '').trim();
    const kind = doc.documentType === 'invoice' ? 'Invoice' : 'Quote';
    const base = vehicle ? `${name} (${vehicle})` : name;
    return `${base} — ${kind} ${number}${ref ? ` [doc=${ref}]` : ''}`;
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
      if (doc.stage === 'accepted') return it.jobId ? 'Paid · Ready to schedule' : 'Paid';
      if (doc.stage === 'draft') return 'Draft';
      if (doc.stage === 'sent') return 'Payment pending';
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
    const reference = workItemDocumentRef(it);
    const document = reference ? this.invoicesData.getInvoiceById(reference) : null;
    return document?.documentType === (stage === 'quote' ? 'quote' : 'invoice') ? document : null;
  }

  private resolvedDocumentRefForLaneCard(item: WorkItem, lane: Lane): string {
    return this.linkedDocumentForCard(item, lane)?.id || '';
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
    const reference = workItemDocumentRef(it);
    if (reference) {
      const document = this.invoicesData.getInvoiceById(reference);
      return document?.documentType === 'invoice' ? [document] : [];
    }
    const customerId = String(it.customerId || '').trim();
    if (!customerId) return [];
    const invoices = this.invoiceDetails().filter(doc => doc.documentType === 'invoice' && doc.customerId === customerId);
    return invoices.length === 1 ? invoices : [];
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

  possibleDuplicateBadgeLabel(it: WorkItem): string {
    const status = String((it as any)?.duplicateReviewStatus || '').trim().toLowerCase();
    if (status !== 'pending') return '';
    return 'Possible Duplicate';
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
    if (lane && this.suppressesGenericNewNotice(lane)) return false;
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
    this.router.navigate(['/customers', customerId], { queryParams: { vehicleId: this.vehicleForWorkItem(it)?.id || it.vehicleId || undefined } });
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
    this.openDocumentBuilderForCustomer(customerId, 'quote', it.id);
  }

  canCreateInvoiceFromQuote(it: WorkItem, lane: Lane): boolean {
    if (this.laneStageKey(lane) !== 'quote') return false;
    const doc = this.linkedDocumentForCard(it, lane);
    if (!doc) return false;
    return doc.documentType === 'quote' && doc.stage === 'accepted' && this.isDocumentActiveOnBoard(doc);
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
      const title = this.cardTitleForDocument(created);
      this.items.update(current => {
        const next: Record<string, WorkItem[]> = {};
        for (const [laneId, rows] of Object.entries(current || {})) {
          next[laneId] = [...(rows || [])].filter(row => row.id !== it.id);
        }
        const targetRows = next[targetLaneId] || [];
        targetRows.unshift({ ...it, title, laneId: targetLaneId });
        next[targetLaneId] = targetRows;
        return next;
      });
      try {
        await firstValueFrom(this.itemsApi.update({ id: it.id, title, laneId: targetLaneId }));
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

  canCreateInvoiceFromUnlinkedCard(item: WorkItem, lane: Lane): boolean {
    return this.laneStageKey(lane) === 'invoiced' && !!item.customerId && !item.jobId && !workItemDocumentRef(item);
  }

  createInvoiceFromUnlinkedCard(item: WorkItem, lane: Lane): void {
    if (this.canCreateInvoiceFromUnlinkedCard(item, lane)) {
      this.openDocumentBuilderForCustomer(item.customerId || '', 'invoice', item.id);
    }
  }

  canOpenFinalInvoice(it: WorkItem, lane: Lane): boolean {
    const stage = this.laneStageKey(lane);
    if (stage !== 'inprogress' && stage !== 'completed') return false;
    const invoice = this.latestPaidInvoiceDocumentForCard(it);
    return !!invoice && Number(invoice.total || 0) > Number(invoice.paidAmount || 0);
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

  markJobPickedUp(item: WorkItem, event: Event): void {
    event.stopPropagation();
    this.itemsApi.update({ id: item.id, markPickedUp: true }).subscribe({
      next: () => { this.status.set('Vehicle marked picked up.'); this.loadAll(); },
      error: error => this.status.set(this.extractApiError(error, 'Could not mark vehicle picked up'))
    });
  }

  jobBalanceLabel(item: WorkItem): string {
    const invoice = this.matchedInvoicesForCard(item).find(doc => doc.documentType === 'invoice');
    if (!invoice) return '';
    const due = this.roundCurrency(Number(invoice.total || 0) - Number(invoice.paidAmount || 0));
    return due > 0
      ? `Balance due ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(due)}`
      : 'Paid in full';
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
    this.markCardSeenByKey(key);
  }

  private markCardSeenForLaneId(it: WorkItem, laneId: string): void {
    if (!this.seenCardsLoaded || !this.seenCardsInitialized) return;
    const itemId = String(it?.id || '').trim();
    const key = this.cardSeenKey(itemId, laneId);
    if (!key) return;
    this.markCardSeenByKey(key);
  }

  private markCardSeenByKey(key: string): void {
    const current = this.seenCardIds();
    if (current[key]) return;
    const next: Record<string, true> = {
      ...current,
      [key]: true
    };
    this.seenCardIds.set(next);
    this.persistSeenCardsNow(next);
  }

  private suppressesGenericNewNotice(lane: Lane | null | undefined): boolean {
    return this.isInProgressLane(lane) || this.isCompletedLane(lane);
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
    const document = this.invoicesData.getInvoiceById(workItemDocumentRef(it));
    if (document?.vehicle && document.vehicle !== 'Vehicle TBD') return document.vehicle;
    const cust = this.customersMap()[it.customerId ?? ''] as any;
    const matched = this.vehicleForWorkItem(it);
    const itemParts = [it.vehicleYear, it.vehicleMake, it.vehicleModel]
      .filter(Boolean)
      .map((s: string | undefined) => String(s || '').trim())
      .filter(Boolean);
    if (itemParts.length) return itemParts.join(' ');
    if (matched) return vehicleSummary(matched) || (matched.vin ? `VIN ${matched.vin}` : '');
    if (it.vin) return `VIN ${it.vin}`;
    const primary = [cust?.vehicleYear, cust?.vehicleMake, cust?.vehicleModel].filter(Boolean).join(' ');
    if (primary) return primary;

    const m = (it.title || '').match(/\(([^)]+)\)/);
    return m?.[1] ?? '';
  }

  colorOf(it: WorkItem): string {
    const cust = this.customersMap()[it.customerId ?? ''] as any;
    const matched = this.vehicleForWorkItem(it);
    const document = this.invoicesData.getInvoiceById(workItemDocumentRef(it));
    const col = (it.vehicleColor || matched?.vehicleColor || (!it.vehicleId && !it.vin && !document?.vehicleId && !document?.vehicleVin ? cust?.vehicleColor : '') || '').toString().trim();
    if (col) return col;

    const m = (it.title || '').match(/\[c=([^\]]+)\]/);
    return m?.[1] ?? '';
  }

  private vehicleForWorkItem(it: WorkItem) {
    const document = this.invoicesData.getInvoiceById(workItemDocumentRef(it));
    const vehicleId = document?.vehicleId || it.vehicleId;
    const vin = document?.vehicleVin || it.vin;
    return customerVehicles(this.customersMap()[it.customerId ?? ''])
      .find(vehicle => vehicle.id === vehicleId || (!!vin && vehicle.vin === vin));
  }

  notesListOf(it: WorkItem): string[] {
    const cust = this.customersMap()[it.customerId ?? ''] as any;
    const lane = this.laneForItem(it);
    const stageKey = this.laneStageKey(lane);
    const out: string[] = [];
    const seen = new Set<string>();

    const add = (value: unknown) => {
      const raw = String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!raw) return;
      const key = raw.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(raw);
    };

    const itemRecord = it as any;
    if (this.isLeadWidgetItem(it)) add(itemRecord.message);
    add(itemRecord.notes);
    if (this.isLeadWidgetItem(it)) add(itemRecord.customerNote);

    const includeCustomerHistory = stageKey !== 'lead' && !out.length;
    if (includeCustomerHistory) {
      const history = Array.isArray(cust?.notesHistory) ? cust.notesHistory : [];
      const sortedHistory = [...history]
        .map((entry: any) => ({
          text: String(entry?.text || '').trim(),
          ts: this.asMillis(entry?.createdAt || '') || 0
        }))
        .filter(entry => !!entry.text)
        .sort((a, b) => a.ts - b.ts);
      for (const entry of sortedHistory) add(entry.text);
      add(cust?.notes);
    }

    const docs: InvoiceDetail[] = [];
    if (stageKey === 'quote' && lane) {
      const linked = this.linkedDocumentForCard(it, lane);
      if (linked?.documentType === 'quote') docs.push(linked);
    } else if (stageKey === 'invoiced') {
      if (lane) {
        const linked = this.linkedDocumentForCard(it, lane);
        if (linked?.documentType === 'invoice') docs.push(linked);
      }
      if (!docs.length) {
        const latest = this.latestInvoiceDocumentForCard(it);
        if (latest) docs.push(latest);
      }
    } else if (stageKey === 'scheduled' || stageKey === 'inprogress' || stageKey === 'completed') {
      const latest = this.latestInvoiceDocumentForCard(it);
      if (latest) docs.push(latest);
    }

    for (const doc of docs) {
      add(String(doc.staffNote || '').trim());
    }

    return out;
  }

  private isLeadWidgetItem(it: WorkItem): boolean {
    const itemRecord = it as any;
    const source = String(itemRecord.source || '').trim().toLowerCase();
    const leadSource = String(itemRecord.leadSource || '').trim().toLowerCase();
    const intakeSource = String(itemRecord.intakeSource || '').trim().toLowerCase();
    const origin = String(itemRecord.origin || '').trim().toLowerCase();
    const channel = String(itemRecord.channel || '').trim().toLowerCase();
    return source === 'web'
      || leadSource === 'web'
      || channel === 'website'
      || intakeSource.includes('widget')
      || origin.includes('widget');
  }

  notesOf(it: WorkItem): string {
    return this.notesListOf(it)[0] || '';
  }

  appointmentLabel(it: WorkItem): string {
    const appointment = this.appointmentScheduleForCard(it);
    if (!appointment) return '';
    const zone = this.shopTimeZone();
    const format = new Intl.DateTimeFormat(undefined, {
      timeZone: zone, dateStyle: 'short', timeStyle: 'medium'
    });
    const start = this.scheduleMillis(appointment.start);
    const end = this.scheduleMillis(appointment.end);
    return start && end ? `${format.format(start)}<br/>${format.format(end)}` : '';
  }

  private appointmentMatchesCard(appointment: ScheduleItem, item: WorkItem): boolean {
    return item.jobId ? appointment.workItemId === item.id
      : !appointment.workItemId && String(appointment.customerId || '').trim() === String(item.customerId || '').trim();
  }

  private appointmentScheduleForCard(it: WorkItem): ScheduleItem | null {
    const customerId = String(it.customerId || '').trim();
    if (!customerId) return null;
    const list = this.scheduleItems()
      .filter(s => this.appointmentMatchesCard(s, it) && !s.isBlocked && !!s.start && !!s.end);
    if (!list.length) return null;
    const now = Date.now();
    const upcoming = list
      .filter(s => this.scheduleMillis(s.start) >= now)
      .sort((a, b) => this.scheduleMillis(a.start) - this.scheduleMillis(b.start));
    if (upcoming.length) return upcoming[0];
    return list.sort((a, b) => this.scheduleMillis(b.start) - this.scheduleMillis(a.start))[0] || null;
  }

  appointmentInfoFlagLabel(it: WorkItem, lane: Lane): string {
    const stage = this.laneStageKey(lane);
    if (stage !== 'scheduled' && stage !== 'inprogress') return '';
    const customerId = String(it.customerId || '').trim();
    if (this.hasSentAppointmentInfoForCustomer(customerId)) return '';
    const schedule = this.appointmentScheduleForCard(it);
    if (!schedule) return '';
    if (schedule.appointmentInfoSentAt) return '';
    return 'Send scheduled info';
  }

  private hasSentAppointmentInfoForCustomer(customerId: string): boolean {
    const id = String(customerId || '').trim();
    if (!id) return false;
    const now = Date.now();
    return this.scheduleItems().some(schedule => {
      if (String(schedule.customerId || '').trim() !== id) return false;
      if (schedule.isBlocked) return false;
      if (!String(schedule.appointmentInfoSentAt || '').trim()) return false;
      const startMs = this.scheduleMillis(schedule.start);
      return !startMs || startMs >= now;
    });
  }

  openAppointmentInfoModal(it: WorkItem, lane: Lane, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    const schedule = this.appointmentScheduleForCard(it);
    if (!schedule) {
      this.status.set('No appointment found for this card.');
      return;
    }
    this.markCardSeen(it, lane);
    this.appointmentInfoItemId.set(String(it.id || '').trim());
    this.appointmentInfoLaneId.set(String(lane.id || '').trim());
    this.appointmentInfoScheduleId.set(String(schedule.id || '').trim());
    this.appointmentInfoSendEmail.set(!!this.appointmentInfoEmailAddressForItem(it));
    this.appointmentInfoSendSms.set(!!this.customerPhone(it));
    this.appointmentInfoMessage.set(this.defaultAppointmentInfoMessage(it, schedule));
    this.appointmentInfoError.set('');
    this.appointmentInfoModalOpen.set(true);
  }

  closeAppointmentInfoModal(): void {
    if (this.appointmentInfoSending()) return;
    this.appointmentInfoModalOpen.set(false);
    this.appointmentInfoItemId.set(null);
    this.appointmentInfoLaneId.set(null);
    this.appointmentInfoScheduleId.set(null);
    this.appointmentInfoError.set('');
  }

  appointmentInfoItem(): WorkItem | null {
    const itemId = String(this.appointmentInfoItemId() || '').trim();
    if (!itemId) return null;
    for (const rows of Object.values(this.items())) {
      const found = rows.find(item => String(item.id || '').trim() === itemId);
      if (found) return found;
    }
    return null;
  }

  appointmentInfoSchedule(): ScheduleItem | null {
    const scheduleId = String(this.appointmentInfoScheduleId() || '').trim();
    if (!scheduleId) return null;
    return this.scheduleItems().find(item => String(item.id || '').trim() === scheduleId) || null;
  }

  appointmentInfoCustomer(): Customer | null {
    const item = this.appointmentInfoItem();
    const customerId = String(item?.customerId || '').trim();
    return customerId ? (this.customersMap()[customerId] || null) : null;
  }

  appointmentInfoEmailAddress(): string {
    const item = this.appointmentInfoItem();
    return item ? this.appointmentInfoEmailAddressForItem(item) : '';
  }

  appointmentInfoPhoneNumber(): string {
    const item = this.appointmentInfoItem();
    return item ? this.customerPhone(item) : '';
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
    if (!this.appointmentInfoSchedule() || !this.appointmentInfoItem()) return false;
    if (!String(this.appointmentInfoMessage() || '').trim()) return false;
    return (this.appointmentInfoSendEmail() && !!this.appointmentInfoEmailAddress())
      || (this.appointmentInfoSendSms() && !!this.appointmentInfoPhoneNumber());
  }

  private appointmentInfoEmailAddressForItem(it: WorkItem): string {
    const customerId = String(it.customerId || '').trim();
    const customer = customerId ? this.customersMap()[customerId] : null;
    return String(customer?.email || '').trim();
  }

  private defaultAppointmentInfoMessage(it: WorkItem, schedule: ScheduleItem): string {
    const customer = this.customersMap()[String(it.customerId || '').trim()] || null;
    const firstName = String(customer?.firstName || this.customerName(it).split(/\s+/)[0] || 'there').trim();
    const business = this.businessDisplayName();
    return `Hi ${firstName}, your appointment with ${business} is ${this.appointmentTimeLabel(schedule)}. If you need to change it, please call us.`;
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

  private calendarDetails(schedule: ScheduleItem, item: WorkItem | null): string {
    const customerName = item ? this.customerName(item) : 'Customer';
    const vehicle = item ? this.vehicleOf(item) : '';
    const lines = [
      `Appointment with ${this.businessDisplayName()}.`,
      customerName ? `Customer: ${customerName}` : '',
      vehicle ? `Vehicle: ${vehicle}` : '',
      String(schedule.notes || '').trim() ? `Notes: ${String(schedule.notes || '').trim()}` : '',
      'Call us if you need to change this appointment.'
    ];
    return lines.filter(Boolean).join('\n');
  }

  private googleCalendarUrl(schedule: ScheduleItem, item: WorkItem | null): string {
    const title = `${this.businessDisplayName()} appointment`;
    const start = this.calendarDateParam(schedule.start || '');
    const end = this.calendarDateParam(schedule.end || schedule.start || '');
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: title,
      dates: `${start}/${end}`,
      details: this.calendarDetails(schedule, item),
      location: this.businessLocation()
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  }

  private outlookCalendarUrl(schedule: ScheduleItem, item: WorkItem | null): string {
    const params = new URLSearchParams({
      path: '/calendar/action/compose',
      rru: 'addevent',
      subject: `${this.businessDisplayName()} appointment`,
      startdt: shopCalendarIso(schedule.start, this.shopTimeZone()),
      enddt: shopCalendarIso(schedule.end || schedule.start, this.shopTimeZone()),
      body: this.calendarDetails(schedule, item),
      location: this.businessLocation()
    });
    return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
  }

  private appointmentEmailHtml(message: string, schedule: ScheduleItem, item: WorkItem | null, portalUrl: string): string {
    const googleUrl = this.googleCalendarUrl(schedule, item);
    const outlookUrl = this.outlookCalendarUrl(schedule, item);
    const vehicle = item ? this.vehicleOf(item) : '';
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
    const item = this.appointmentInfoItem();
    const schedule = this.appointmentInfoSchedule();
    if (!item || !schedule) {
      this.appointmentInfoError.set('Missing appointment details.');
      return;
    }
    const message = String(this.appointmentInfoMessage() || '').trim();
    if (!message) {
      this.appointmentInfoError.set('Enter a message before sending.');
      return;
    }
    const customerId = String(item.customerId || '').trim();
    const customerName = this.customerName(item);
    const email = this.appointmentInfoEmailAddress();
    const phone = this.appointmentInfoPhoneNumber();
    if (this.appointmentInfoSending()) return;
    const sendEmail = this.appointmentInfoSendEmail();
    const sendSms = this.appointmentInfoSendSms();
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

    if (sendEmail) {
      const plain = `${message}\n\nAppointment: ${this.appointmentTimeLabel(schedule)}\n\nAdd to Google Calendar: ${this.googleCalendarUrl(schedule, item)}\nAdd to Outlook Calendar: ${this.outlookCalendarUrl(schedule, item)}${visitMessage}`;
      sends.push(firstValueFrom(this.emailApi.sendToCustomer({
        customerId,
        customerName,
        to: email,
        subject: `${this.businessDisplayName()} appointment details`,
        message: plain,
        html: this.appointmentEmailHtml(message, schedule, item, portalUrl),
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

    const sentAt = new Date().toISOString();
    const sentPatch: Partial<ScheduleItem> = {
      appointmentInfoSentAt: sentAt,
      appointmentInfoSentVia: sentVia.join(','),
      appointmentInfoMessage: message,
      appointmentInfoSentScheduleStart: String(schedule.start || ''),
      appointmentInfoSentScheduleEnd: String(schedule.end || ''),
      appointmentInfoSentResource: String(schedule.resource || '')
    };
    try {
      await firstValueFrom(this.scheduleApi.update({
        id: schedule.id,
        ...sentPatch
      }));
      this.scheduleItems.update(rows => (rows || []).map(row => String(row.id || '').trim() === String(schedule.id || '').trim()
        ? { ...row, ...sentPatch }
        : row
      ));
      this.status.set(partialFailure
        ? `Scheduled info sent by ${sentVia.join(' and ')}. Another channel failed: ${String(partialFailure.reason?.message || partialFailure.reason || 'Unknown error')}.`
        : 'Scheduled info sent.');
      this.appointmentInfoSending.set(false);
      this.closeAppointmentInfoModal();
      this.loadAll();
    } catch (error: any) {
      this.appointmentInfoError.set(error?.message || 'Sent, but could not update the schedule record.');
    } finally {
      this.appointmentInfoSending.set(false);
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
      const startMs = this.scheduleMillis(s.start);
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

  private hasCalendarEventForItem(item: WorkItem): boolean {
    if (!item.jobId) return this.hasCalendarEvent(String(item.customerId || ''));
    return this.scheduleItems().some(s => s.workItemId === item.id && !s.isBlocked && !!s.start && !!s.end);
  }

  private futureScheduleCustomerIds(nowMs: number = Date.now()): Set<string> {
    const ids = new Set<string>();
    for (const item of this.scheduleItems()) {
      const customerId = (item.customerId || '').trim();
      if (!customerId || item.workItemId || item.isBlocked || !item.start || !item.end) continue;
      const startMs = this.scheduleMillis(item.start);
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

  private inferredCustomerIdFromItem(item: WorkItem): string {
    const direct = String(item.customerId || '').trim();
    if (direct) return direct;
    const name = String(this.customerName(item) || '').trim().toLowerCase();
    if (name) {
      const exactName = this.allCustomers().find(customer =>
        String(customer.name || '').trim().toLowerCase() === name
      );
      if (exactName?.id) return String(exactName.id).trim();
    }
    const phone = String(this.customerPhone(item) || '').replace(/\D+/g, '');
    if (phone) {
      const byPhone = this.allCustomers().find(customer =>
        String(customer.phone || '').replace(/\D+/g, '') === phone
      );
      if (byPhone?.id) return String(byPhone.id).trim();
    }
    return '';
  }

  private effectiveCustomerIdForItem(item: WorkItem): string {
    return this.inferredCustomerIdFromItem(item);
  }

  private scheduleMillis(value: string | undefined): number {
    return shopTimeMillis(value, this.shopTimeZone()) || 0;
  }

  private effectiveScheduleEndMs(item: ScheduleItem): number {
    const plannedEnd = this.scheduleMillis(item.end);
    const actualEnd = this.scheduleMillis(item.actualEnd);
    const releasedAt = this.scheduleMillis(item.bayReleasedAt);
    let effective = plannedEnd;
    if (actualEnd && (!effective || actualEnd < effective)) effective = actualEnd;
    if (releasedAt && (!effective || releasedAt < effective)) effective = releasedAt;
    return effective;
  }

  private activeScheduleIdsForCustomerAt(customerId: string, atMs: number, workItemId?: string): string[] {
    const key = String(customerId || '').trim();
    if (!key) return [];
    return this.scheduleItems()
      .filter(item => {
        if (!!item.isBlocked) return false;
        if (String(item.customerId || '').trim() !== key || (item.workItemId || undefined) !== workItemId) return false;
        const startMs = this.scheduleMillis(item.start);
        const endMs = this.effectiveScheduleEndMs(item);
        if (!startMs || !endMs || endMs <= startMs) return false;
        return startMs <= atMs && atMs < endMs;
      })
      .map(item => String(item.id || '').trim())
      .filter(Boolean);
  }

  private releaseActiveBayForCustomer(customerId: string, releasedAtIso: string, workItemId?: string): void {
    const whenMs = this.asMillis(releasedAtIso);
    if (!whenMs) return;
    const targetIds = new Set(this.activeScheduleIdsForCustomerAt(customerId, whenMs, workItemId));
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

  private reopenReleasedBayForCustomer(customerId: string, workItemId?: string): void {
    const nowMs = Date.now();
    const key = String(customerId || '').trim();
    if (!key) return;
    const candidates = this.scheduleItems()
      .filter(item => {
        if (!!item.isBlocked) return false;
        if (String(item.customerId || '').trim() !== key || (item.workItemId || undefined) !== workItemId) return false;
        if (!String(item.bayReleasedAt || '').trim()) return false;
        const startMs = this.scheduleMillis(item.start);
        const endMs = this.scheduleMillis(item.end);
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
            error: () => {
              this.itemsApi.delete(created.id).subscribe({
                next: () => createNext(),
                error: () => createNext()
              });
            }
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
    const repairedCustomerIds: Array<{ id: string; customerId: string }> = [];
    const map: Record<string, WorkItem[]> = {};
    for (const [laneId, rows] of Object.entries(this.items())) {
      map[laneId] = [...rows].map(row => ({ ...row }));
      for (const row of map[laneId] || []) {
        const customerId = this.effectiveCustomerIdForItem(row);
        if (!customerId) continue;
        if (!String(row.customerId || '').trim()) {
          row.customerId = customerId;
          const id = String(row.id || '').trim();
          if (id) repairedCustomerIds.push({ id, customerId });
        }
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
    const scheduledCustomerIds = new Set(
      (map[scheduledId] || [])
        .map(item => this.effectiveCustomerIdForItem(item))
        .filter(Boolean)
    );

    const movedToScheduled: WorkItem[] = [];
    const movedOutOfScheduled: Array<{ item: WorkItem; targetLaneId: string }> = [];
    const removedFromScheduled: WorkItem[] = [];
    for (const laneId of Object.keys(map)) {
      if (this.isInProgressLaneById(laneId) || this.isCompletedLaneById(laneId)) continue;
      const lane = this.lanes().find(row => row.id === laneId);
      const keep: WorkItem[] = [];
      for (const it of map[laneId] || []) {
        if (lane && !this.shouldShowLaneCard(it, lane)) {
          keep.push(it);
          continue;
        }
        const alreadyCheckedIn = !!(it.checkedInAt || '').trim();
        const customerId = this.effectiveCustomerIdForItem(it);
        const useLegacySchedule = !it.jobId && (!workItemDocumentRef(it) || laneId === scheduledId);
        const hasFutureSchedule = useLegacySchedule
          ? !!customerId && futureCustomerIds.has(customerId)
          : this.scheduleItems().some(s => s.workItemId === it.id && !s.isBlocked && this.scheduleMillis(s.end) > nowMs);
        const hasActiveCheckIn = customerId ? activeCheckedInCustomerIds.has(customerId) : false;
        const hasProtectedLaneCard = customerId ? customersWithProtectedLaneCards.has(customerId) : false;

        if (laneId !== scheduledId) {
          if (
            customerId &&
            hasFutureSchedule &&
            !alreadyCheckedIn &&
            (it.jobId || !hasActiveCheckIn) &&
            !this.isLeadLaneById(laneId) &&
            (it.jobId || !scheduledCustomerIds.has(customerId))
          ) {
            movedToScheduled.push({ ...it, laneId: scheduledId });
            scheduledCustomerIds.add(customerId);
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

        if (!it.jobId && hasProtectedLaneCard && !hasFutureSchedule && !alreadyCheckedIn && !hasActiveCheckIn) {
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

    const scheduledRows = [...(map[scheduledId] || [])];
    if (scheduledRows.length > 1) {
      const keepByCustomer = new Map<string, WorkItem>();
      const removeScheduledIds = new Set<string>();
      for (const row of scheduledRows) {
        const customerKey = this.workflowCustomerKey(row);
        if (!customerKey) continue;
        const existing = keepByCustomer.get(customerKey);
        if (!existing) {
          keepByCustomer.set(customerKey, row);
          continue;
        }
        const existingCheckedIn = !!String(existing.checkedInAt || '').trim();
        const rowCheckedIn = !!String(row.checkedInAt || '').trim();
        let keepRow = false;
        if (rowCheckedIn && !existingCheckedIn) {
          keepRow = true;
        } else if (rowCheckedIn === existingCheckedIn) {
          const existingUpdated = this.asMillis(String(existing.updatedAt || existing.createdAt || ''));
          const rowUpdated = this.asMillis(String(row.updatedAt || row.createdAt || ''));
          if (rowUpdated >= existingUpdated) keepRow = true;
        }
        if (keepRow) {
          const removeId = String(existing.id || '').trim();
          if (removeId) removeScheduledIds.add(removeId);
          keepByCustomer.set(customerKey, row);
        } else {
          const removeId = String(row.id || '').trim();
          if (removeId) removeScheduledIds.add(removeId);
        }
      }
      if (removeScheduledIds.size) {
        map[scheduledId] = scheduledRows.filter(row => !removeScheduledIds.has(String(row.id || '').trim()));
        removedFromScheduled.push(
          ...scheduledRows.filter(row => removeScheduledIds.has(String(row.id || '').trim()))
        );
      }
    }

    if (movedToScheduled.length || movedOutOfScheduled.length || removedFromScheduled.length || repairedCustomerIds.length) {
      const duplicateIds = Array.from(new Set([
        ...this.pruneDuplicateDocumentCardsInMap(map, this.lanes()),
        ...this.pruneWorkflowLaneDuplicatesInMap(map, this.lanes()),
        ...this.pruneLifecycleStageDuplicatesInMap(map, this.lanes())
      ]));
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
      for (const patch of repairedCustomerIds) {
        this.itemsApi.update({ id: patch.id, customerId: patch.customerId }).subscribe({ error: () => {} });
      }
      for (const it of removedFromScheduled) {
        this.itemsApi.delete(it.id).subscribe({ error: () => {} });
      }
      for (const id of duplicateIds) {
        this.itemsApi.delete(id).subscribe({ error: () => {} });
      }
    }

    const scheduledCustomers = new Set(
      (map[scheduledId] || [])
        .map(item => this.effectiveCustomerIdForItem(item))
        .filter(Boolean)
    );
    const customersWithNonScheduledCards = new Set(
      Object.entries(map)
        .filter(([laneId]) => laneId !== scheduledId)
        .flatMap(([, rows]) => (rows || []).map(item => this.effectiveCustomerIdForItem(item)))
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

  private syncInvoiceResponsesFromApi(): void {
    if (!this.auth.isAuthenticated()) return;
    this.invoiceResponseApi.listRecent(250).subscribe({
      next: response => {
        const items = Array.isArray(response?.items) ? response.items : [];
        let applied = false;

        for (const item of items) {
          const invoiceId = String(item?.invoiceId || '').trim();
          const stage = String(item?.stage || '').trim().toLowerCase();
          const responseUpdatedAt = String(item?.updatedAt || '').trim();
          if (!invoiceId || stage !== 'accepted') continue;

          const existing = this.invoicesData.getInvoiceById(invoiceId);
          if (!existing || existing.documentType !== 'invoice') continue;

          const responseUpdatedMs = this.asMillis(responseUpdatedAt || new Date().toISOString());
          const invoiceUpdatedMs = this.asMillis(existing.updatedAt || existing.createdAt || '');
          const total = Number(existing.total || 0);
          const paid = Number(existing.paidAmount || 0);
          const alreadyPaidInFull = total > 0
            && (existing.stage === 'accepted' || existing.stage === 'completed')
            && paid >= total;
          const settledAmount = this.roundCurrency(Number(item.paidAmount || 0));
          if (settledAmount <= 0 || settledAmount < paid) continue;
          const paymentAmount = this.roundCurrency(Number(item.paymentAmount || 0));
          const transactionId = String((item as any)?.paymentTransactionId || '').trim();
          const noticeKey = [
            invoiceId,
            responseUpdatedAt,
            transactionId || paymentAmount || 'paid'
          ].join('|');

          if (responseUpdatedMs && invoiceUpdatedMs && responseUpdatedMs < invoiceUpdatedMs && !alreadyPaidInFull) continue;
          if (alreadyPaidInFull) {
            if (this.markPaidInvoiceResponseAttention(existing, noticeKey)) {
              applied = true;
            }
            continue;
          }

          const wasFinalInvoicePayment = item.paymentKind === 'final';
          const provider = this.normalizeRefundProviderKey(String((item as any)?.paymentProvider || existing.paymentProviderKey || '').trim().toLowerCase());
          const accountNumber = this.maskedAccountForRefund(String((item as any)?.paymentAccountNumber || '').trim());
          if (['authorize-net', 'paylynx'].includes(provider) && transactionId && paymentAmount > 0) {
            this.invoicesData.recordPaymentTransaction(existing.id, {
              provider,
              amount: paymentAmount,
              transactionId,
              accountNumber,
              createdAt: responseUpdatedAt || new Date().toISOString()
            });
          }

          this.invoicesData.setPaidAmount(existing.id, settledAmount, 'Payment recorded on invoice.', 'customer');
          if (settledAmount >= total && !wasFinalInvoicePayment) {
            this.invoicesData.setStage(existing.id, 'accepted', 'Initial invoice paid.', 'customer');
          }
          this.markPaidInvoiceResponseAttention(existing, noticeKey);
          applied = true;
        }

        if (!applied) return;
        this.syncScheduledLane();
      },
      error: () => {
        // Keep dashboard functional when response sync endpoint is temporarily unavailable.
      }
    });
  }

  private syncQuoteResponsesFromApi(): void {
    if (!this.auth.isAuthenticated()) return;
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
        }
      },
      error: () => {
        // Keep dashboard functional when response sync endpoint is temporarily unavailable.
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

  private markPaidInvoiceResponseAttention(doc: InvoiceDetail, noticeKey: string): boolean {
    this.markDashboardCardsAsUnseenForDocument(doc);

    const key = String(noticeKey || doc.id || doc.invoiceNumber || '').trim();
    if (!key || this.invoicePaidResponseNoticeKeys.has(key)) return false;
    this.invoicePaidResponseNoticeKeys.add(key);
    this.emitNotificationsRefresh();
    return true;
  }

  private normalizeRefundProviderKey(provider: string): string {
    const normalized = String(provider || '').trim().toLowerCase().replace(/[\s_.]+/g, '-');
    if (!normalized) return '';
    if (normalized === 'authorizenet' || normalized === 'authorize-net' || normalized === 'authorize.net') {
      return 'authorize-net';
    }
    return normalized;
  }

  private maskedAccountForRefund(raw: string): string {
    const digits = String(raw || '').replace(/\D+/g, '');
    if (digits.length < 4) return '';
    return `XXXX${digits.slice(-4)}`;
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

  private emitNotificationsRefresh(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('pathflow:notifications-refresh'));
  }

  openScheduleModal(customerId: string, workItemId: string | null = null) {
    this.scheduleModalCustomerId.set(customerId);
    this.scheduleModalWorkItemId.set(workItemId);
    this.scheduleModalOpen.set(true);
  }

  private routeToSchedulePlanner(customerId: string): void {
    const id = String(customerId || '').trim();
    if (!id) return;
    this.clearResidualDragState();
    this.router.navigate(['/schedule'], {
      queryParams: {
        customerId: id,
        autoOpen: '0',
        source: 'dashboard',
        showSuggestions: '1'
      }
    });
  }

  closeScheduleModal() {
    this.scheduleModalOpen.set(false);
    this.scheduleModalCustomerId.set(null);
    this.scheduleModalWorkItemId.set(null);
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
    if (document.querySelector('dialog[open], .ui-popover-panel')) return;
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
    this.phoneInquiry.set('');
  }

  addingLead(): boolean {
    return this.searchLaneId() === this.leadLaneId();
  }

  addingInvoice(): boolean {
    const laneId = this.searchLaneId();
    return !!laneId && laneId === this.invoicedLaneId();
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
    if (this.addingInvoice()) {
      this.closeSearch();
      this.openDocumentBuilderForCustomer(c.id, 'invoice');
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
    this.status.set('Creating card');
    if (this.addingLead()) {
      this.logPhoneLead(c, laneId, this.phoneInquiry().trim());
      return;
    }
    this.itemsApi.create(this.customerCardTitle(c), laneId).subscribe({
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
              this.status.set('Opened calendar planner for this scheduled customer.');
              this.routeToSchedulePlanner(c.id);
            }
          },
          error: () => this.status.set('Could not link the customer to the card.')
        });
      },
      error: () => { this.status.set('Create card error'); }
    });
  }

  openAddCustomerForLane() {
    const laneId = this.searchLaneId();
    if (!laneId) return;
    const isLead = this.addingLead();
    this.pendingPhoneInquiry = isLead ? this.phoneInquiry().trim() : '';
    this.closeSearch();
    this.customerModalMode.set(isLead ? 'lead' : 'add');
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
    this.pendingPhoneInquiry = '';
  }

  onCustomerSaved(cust: Customer) {
    const laneId = this.laneToLinkAfterSave();
    const phoneInquiry = this.pendingPhoneInquiry;
    this.onCustomerModalClosed();
    if (!laneId) { this.status.set('Saved'); this.loadAll(); return; }
    if (this.isLeadLaneById(laneId)) {
      this.allCustomers.update(customers => customers.some(customer => customer.id === cust.id)
        ? customers
        : [...customers, cust]);
      this.logPhoneLead(cust, laneId, phoneInquiry);
      return;
    }

    this.searchLaneId.set(laneId);
    this.addExistingToLane(cust);
  }

  private logPhoneLead(customer: Customer, laneId: string, message: string): void {
    this.itemsApi.create(this.customerCardTitle(customer), laneId, {
      source: 'phone', message, customerId: customer.id
    }).subscribe({
      next: () => { this.closeSearch(); this.loadAll(); this.status.set('Phone inquiry logged.'); },
      error: error => {
        this.openSearch(laneId);
        this.searchTerm.set(customer.phone || customer.name);
        this.phoneInquiry.set(message);
        this.status.set(this.extractApiError(error, 'Could not log phone inquiry. Select the caller to retry.'));
      }
    });
  }

  private customerCardTitle(customer: Customer): string {
    const name = customer.name?.trim() || 'Unnamed';
    const vehicle = this.customerVehicleBasic(customer);
    return vehicle ? `${name} (${vehicle})` : name;
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
    const base = (this.items()[laneId] || []).filter(item => !item.dashboardHidden);
    const lane = this.lanes().find(item => item.id === laneId) || null;
    if (lane) {
      if (this.isCompletedLane(lane)) {
        const visible = base.filter(item => item.jobId
          ? !item.pickedUpAt || this.canOpenFinalInvoice(item, lane) ||
            !isExpiredCompletedCard({ ...item, completedAt: item.pickedUpAt })
          : !isExpiredCompletedCard(item));
        visible.sort((a, b) => this.compareCreatedDesc(a, b));
        return visible;
      }
      const stage = this.laneStageKey(lane);
      if (stage === 'quote' || stage === 'invoiced') {
        const byDocument = new Map<string, WorkItem>();
        for (const item of base) {
          if (!this.shouldShowLaneCard(item, lane)) continue;
          const docRef = String(this.resolvedDocumentRefForLaneCard(item, lane) || '').trim().toLowerCase();
          if (!docRef) {
            byDocument.set(`id:${String(item.id || '').trim()}`, item);
            continue;
          }
          const existing = byDocument.get(docRef);
          if (!existing) {
            byDocument.set(docRef, item);
            continue;
          }
          const existingTime = this.asMillis(String(existing.updatedAt || existing.createdAt || ''));
          const itemTime = this.asMillis(String(item.updatedAt || item.createdAt || ''));
          if (itemTime >= existingTime) {
            byDocument.set(docRef, item);
          }
        }
        const deduped = Array.from(byDocument.values());
        deduped.sort((a, b) => this.compareCreatedDesc(a, b));
        return deduped;
      }
    }
    const arr = [...base];
    arr.sort((a, b) => this.compareCreatedDesc(a, b));
    return arr;
  }

  private shouldShowLaneCard(item: WorkItem, lane: Lane): boolean {
    const stage = this.laneStageKey(lane);
    if (stage !== 'quote') return true;
    const linked = this.linkedDocumentForCard(item, lane);
    if (!linked || linked.documentType !== 'quote') return true;
    return this.isDocumentActiveOnBoard(linked);
  }

  private isDocumentActiveOnBoard(doc: InvoiceDetail): boolean {
    return doc.stage !== 'canceled' && doc.stage !== 'expired' &&
      (doc.documentType !== 'quote' || !this.convertedQuoteIds().has(doc.id.toLowerCase()));
  }

  laneItemCount(laneId: string): number {
    return this.getLaneCards(laneId).length;
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
      const sourceRendered = Array.isArray(event.previousContainer.data) ? event.previousContainer.data : (map[sourceId] || []);
      const targetRendered = Array.isArray(event.container.data) ? event.container.data : (map[targetId] || []);
      const moved = sourceRendered[event.previousIndex] || map[sourceId]?.[event.previousIndex];
      if (!moved) return;
      const sourceLane = this.lanes().find(lane => lane.id === sourceId) || null;
      const targetLane = this.lanes().find(lane => lane.id === targetLaneId) || null;
      if (sourceLane && targetLane && this.laneStageKey(sourceLane) === 'quote' && this.laneStageKey(targetLane) === 'invoiced') {
        const quote = this.linkedDocumentForCard(moved, sourceLane);
        if (!quote) {
          this.status.set('Create and accept a quote before creating its invoice.');
        } else if (quote.stage !== 'accepted') {
          this.status.set('The quote must be accepted before creating an invoice.');
        } else if (!this.canCreateInvoiceFromQuote(moved, sourceLane)) {
          this.status.set('This quote already has an invoice. Open it from Invoices.');
        } else {
          void this.createInvoiceFromQuoteCard(moved, sourceLane);
        }
        return;
      }
      const movedId = String(moved.id || '').trim();
      map[sourceId] = (map[sourceId] || []).filter(row => String(row.id || '').trim() !== movedId);
      const targetExisting = (map[targetId] || []).filter(row => String(row.id || '').trim() !== movedId);
      const renderedTargetIds = targetRendered
        .map(row => String(row?.id || '').trim())
        .filter(id => !!id && id !== movedId);
      const boundedIndex = Math.max(0, Math.min(event.currentIndex, renderedTargetIds.length));
      const beforeId = renderedTargetIds[boundedIndex];
      const insertAt = beforeId
        ? Math.max(0, targetExisting.findIndex(row => String(row.id || '').trim() === beforeId))
        : targetExisting.length;
      const canonicalMoved = (this.items()[sourceId] || []).find(row => String(row.id || '').trim() === movedId) || moved;
      const movedForTarget = { ...canonicalMoved, laneId: targetLaneId };
      targetExisting.splice(insertAt, 0, movedForTarget);
      map[targetId] = targetExisting;
      const movedCustomerId = this.effectiveCustomerIdForItem(moved);
      const launchQuoteAfterMove = this.isQuoteLaneById(targetLaneId);

      // Prevent a temporary duplicate flash when a Scheduled card is dragged
      // back into a document lane that already has a card for the same linked doc.
      if (
        moved &&
        sourceLane &&
        targetLane &&
        this.laneStageKey(sourceLane) === 'scheduled' &&
        (this.laneStageKey(targetLane) === 'quote' || this.laneStageKey(targetLane) === 'invoiced')
      ) {
        const movedDocRef = String(this.resolvedDocumentRefForLaneCard(moved, targetLane) || '').trim().toLowerCase();
        if (movedDocRef) {
          const targetRows = map[targetLaneId] || [];
          const alreadyExistsInTarget = targetRows.some(row => {
            const rowDocRef = String(this.resolvedDocumentRefForLaneCard(row, targetLane) || '').trim().toLowerCase();
            return !!rowDocRef && rowDocRef === movedDocRef;
          });
          if (alreadyExistsInTarget) {
            map[sourceId] = (map[sourceId] || []).filter(row => String(row.id || '').trim() !== String(moved.id || '').trim());
            this.items.set(map);
            this.maybeInitializeSeenLeads(map);
            this.maybeInitializeSeenCards(map);
            this.maybeInitializeNotifiedLeads(map);
            this.maybeNotifyNewLeads(map);
            this.itemsApi.delete(String(moved.id || '').trim()).subscribe({ error: () => {} });
            this.status.set('Card already exists in target lane. Removed duplicate.');
            return;
          }
        }
      }

      if (launchQuoteAfterMove && !movedCustomerId) {
        this.status.set('Select a customer before creating a quote.');
        return;
      }
      const toCompleted = this.isCompletedLaneById(targetLaneId);
      const fromCompleted = this.isCompletedLaneById(sourceId);
      const scheduledId = this.scheduledLaneId();
      const isTargetScheduled = !!scheduledId && targetLaneId === scheduledId;
      const movedOutOfScheduled = !!(scheduledId && sourceId === scheduledId && targetLaneId !== scheduledId);
      if (movedCustomerId && this.isScheduleRequiredLaneById(targetLaneId) && !this.hasCalendarEvent(movedCustomerId)) {
        if (!toCompleted && !isTargetScheduled) {
          this.status.set('Calendar event required before moving to this lane.');
          this.openScheduleModal(movedCustomerId);
          return;
        }
      }
      const needsSchedulePrompt = !!(isTargetScheduled && movedCustomerId && !this.hasFutureSchedule(movedCustomerId));

      const duplicateIds = Array.from(new Set([
        ...this.pruneDuplicateDocumentCardsInMap(map, this.lanes()),
        ...this.pruneWorkflowLaneDuplicatesInMap(map, this.lanes()),
        ...this.pruneLifecycleStageDuplicatesInMap(map, this.lanes())
      ]));
      this.items.set(map);
      this.maybeInitializeSeenLeads(map);
      this.maybeInitializeSeenCards(map);
      this.maybeInitializeNotifiedLeads(map);
      this.maybeNotifyNewLeads(map);
      for (const id of duplicateIds) {
        this.itemsApi.delete(id).subscribe({ error: () => {} });
      }
      const updated = (map[targetId] || []).find(row => String(row.id || '').trim() === movedId)
        || map[targetId][event.currentIndex];
      if (!updated) {
        this.loadAll();
        return;
      }
      const fromInProgress = this.isInProgressLaneById(sourceId);
      const toInProgress = this.isInProgressLaneById(targetLaneId);
      const hasCheckIn = !!(updated.checkedInAt || '').trim();
      const needsAutoCheckIn = toInProgress && !hasCheckIn;
      const needsResume = toInProgress && hasCheckIn && (!!updated.isPaused || !!(updated.pausedAt || '').trim());
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
          lastWorkResumedAt: '',
          workClockState: 'not-started',
          activeWorkDurationMs: 0,
          workDurationMs: this.safeDuration(updated.workDurationMs),
          pauseDurationMs: this.safeDuration(updated.pauseDurationMs)
        });
      }
      const updateBody: Partial<WorkItem> & { id: string; workClockAction?: WorkClockAction } = { id: updated.id, laneId: targetLaneId };
      if (needsAutoCheckIn) {
        updateBody.workClockAction = 'check-in';
        updateBody.checkedInAt = autoCheckInAt;
        updateBody.completedAt = '';
        updateBody.calendarOverrideAt = '';
        updateBody.isPaused = false;
        updateBody.pausedAt = '';
        updateBody.lastWorkResumedAt = '';
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
          if (toInProgress || toCompleted) {
            this.markCardSeenForLaneId(updated, targetLaneId);
          }
          if (needsCalendarOverride) {
            this.status.set('Moved to Completed. Click "No appointment required" to confirm override.');
          }
          if (needsSchedulePrompt && movedCustomerId) {
            this.status.set('Moved to Scheduled. Select an open calendar slot to place this job.');
            this.routeToSchedulePlanner(movedCustomerId);
          }
          if (launchQuoteAfterMove && movedCustomerId) {
            this.openQuoteBuilderForCustomer(movedCustomerId);
            this.status.set('Opening quote builder');
          }
          if (movedCustomerId && toCompleted) {
            this.releaseActiveBayForCustomer(movedCustomerId, nowIso, updated.jobId ? updated.id : undefined);
          } else if (movedCustomerId && fromCompleted && toInProgress) {
            this.reopenReleasedBayForCustomer(movedCustomerId, updated.jobId ? updated.id : undefined);
          }
          if (movedCustomerId && movedOutOfScheduled) {
            this.deleteFutureAppointmentsForCustomer(movedCustomerId, updated.jobId ? updated.id : undefined);
          }
        }
      });
    }
  }

  createdAtLabel(it: WorkItem): string {
    if (!it.createdAt) return '';
    try { return new Date(it.createdAt).toLocaleString(); } catch { return String(it.createdAt); }
  }

  private extractApiError(err: unknown, fallback: string): string {
    const source = err as {
      error?: { detail?: unknown; error?: unknown; message?: unknown } | string;
      message?: unknown;
    } | null;
    const detail =
      (typeof source?.error === 'object' && source.error
        ? source.error.detail || source.error.error || source.error.message
        : source?.error) ||
      source?.message;
    const message = String(detail || '').trim();
    return message ? `${fallback}: ${message}` : fallback;
  }

  trackLane(_i: number, l: Lane) { return l.id; }
  trackItem(_i: number, it: WorkItem) { return it.id; }

  private openQuoteBuilderForCustomer(customerId: string): void {
    this.openDocumentBuilderForCustomer(customerId, 'quote');
  }

  private openDocumentBuilderForCustomer(customerId: string, type: InvoiceDocumentType, workItemId?: string): void {
    const id = String(customerId || '').trim();
    if (!id) return;
    const customer = this.customersMap()[id];
    const queryParams: Record<string, string> = {
      type,
      customerId: id
    };
    if (workItemId) queryParams['workItemId'] = workItemId;
    const workItem = Object.values(this.items()).flat().find(item => item.id === workItemId);
    const vehicle = workItem ? this.vehicleForWorkItem(workItem) : undefined;
    if (vehicle) queryParams['vehicleId'] = vehicle.id;
    if (customer) {
      queryParams['customerName'] = customer.name || '';
      queryParams['customerEmail'] = customer.email || '';
      queryParams['customerPhone'] = customer.phone || '';
      queryParams['customerVehicle'] = this.customerVehicleBasic(customer);
    }
    this.router.navigate(['/invoices/new'], { queryParams });
  }
}
