import { Injectable, computed, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import {
  AccessProfileResponse,
  AuthAccessState,
  AuthLocation,
  AuthMeResponse,
  AuthState,
  AuthUser,
  ClientPrincipal
} from './auth.models';

const DEV_AUTH_STORAGE_KEY = 'exodus.dev.auth.user';
const AUTH_PROFILE_STORAGE_KEY = 'exodus.auth.profile';
const LOCAL_PASSWORD_ACCOUNTS_KEY = 'pathflow.local.password.accounts';
const DEFAULT_LOCATION_ID = 'primary-location';
const DEFAULT_LOCATION_NAME = 'Primary Location';

interface DevAuthRecord {
  role: 'admin' | 'user';
  email: string;
  displayName?: string;
  phone?: string;
  avatarUrl?: string;
}

interface LocalPasswordAccount {
  email: string;
  password: string;
  role: 'admin' | 'user';
  displayName?: string;
  phone?: string;
  avatarUrl?: string;
  registered?: boolean;
}

interface RegistrationBillingPayload {
  cardholderName: string;
  cardNumber: string;
  expiryMonth: string;
  expiryYear: string;
  cvc: string;
  postalCode: string;
  sandboxBypass?: boolean;
}

interface DevSessionOptions {
  registered?: boolean;
  canBootstrap?: boolean;
  isSuperAdmin?: boolean;
  locations?: AuthLocation[];
  defaultLocationId?: string;
  billingStatus?: string;
  trialStartsAt?: string;
  trialEndsAt?: string;
  accessLocked?: boolean;
  accessLockReason?: string;
  planCycle?: 'monthly' | 'annual';
}

interface AccessHydrationResult {
  roles: string[];
  state: AuthAccessState;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  private readonly stateSignal = signal<AuthState>({
    initialized: false,
    loading: true,
    source: 'none',
    user: null
  });
  private readonly accessSignal = signal<AuthAccessState>(this.emptyAccessState(false));

  private bootstrapping: Promise<void> | null = null;

  readonly state = computed(() => this.stateSignal());
  readonly initialized = computed(() => this.stateSignal().initialized);
  readonly loading = computed(() => this.stateSignal().loading);
  readonly user = computed(() => this.stateSignal().user);
  readonly isAuthenticated = computed(() => this.stateSignal().user !== null);
  readonly isAdmin = computed(() => this.hasRole('admin'));
  readonly isRegistered = computed(() => this.accessSignal().registered);
  readonly needsRegistration = computed(() => this.isAuthenticated() && this.accessSignal().loaded && !this.accessSignal().registered);
  readonly isAccessLocked = computed(() => this.accessSignal().accessLocked);
  readonly accessLockReason = computed(() => this.accessSignal().accessLockReason);
  readonly billingStatus = computed(() => this.accessSignal().billingStatus);
  readonly trialEndsAt = computed(() => this.accessSignal().trialEndsAt);
  readonly planCycle = computed(() => this.accessSignal().planCycle);
  readonly canBootstrapRegistration = computed(() => this.accessSignal().canBootstrap);
  readonly isSuperAdmin = computed(() => this.accessSignal().isSuperAdmin);
  readonly locations = computed(() => this.accessSignal().locations);
  readonly defaultLocationId = computed(() => this.accessSignal().defaultLocationId);

  constructor() {
    void this.bootstrap();
  }

  bootstrap(force = false): Promise<void> {
    if (!force && this.stateSignal().initialized) {
      return Promise.resolve();
    }
    if (!force && this.bootstrapping) {
      return this.bootstrapping;
    }

    this.stateSignal.update(current => ({ ...current, loading: true }));
    this.accessSignal.set(this.emptyAccessState(false));

    this.bootstrapping = this.hydrateAuthState()
      .catch(() => {
        this.stateSignal.set({
          initialized: true,
          loading: false,
          source: 'none',
          user: null
        });
        this.accessSignal.set(this.emptyAccessState(true));
      })
      .finally(() => {
        this.bootstrapping = null;
      });

    return this.bootstrapping;
  }

  hasRole(role: string): boolean {
    const user = this.user();
    if (!user) return false;
    const check = role.trim().toLowerCase();
    if (!check) return false;
    return user.roles.some(r => r.toLowerCase() === check);
  }

  signIn(provider?: string, redirectTo?: string): void {
    const selectedProvider = (provider || environment.auth.primaryProvider || 'aad').trim();
    const target = this.normalizeRedirect(redirectTo);
    const url = `/.auth/login/${selectedProvider}?post_login_redirect_uri=${encodeURIComponent(target)}`;
    window.location.assign(url);
  }

  signOut(redirectTo = '/login'): void {
    const source = this.stateSignal().source;
    this.clearDevUser();
    this.stateSignal.set({
      initialized: false,
      loading: true,
      source: 'none',
      user: null
    });
    this.accessSignal.set(this.emptyAccessState(false));

    const target = this.normalizeRedirect(redirectTo, '/login');
    if (source === 'dev') {
      window.location.assign(target);
      return;
    }

    window.location.assign(`/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(target)}`);
  }

  signInDev(role: 'admin' | 'user', email?: string): void {
    const fallbackEmail = role === 'admin' ? 'admin.local@yourcompany.dev' : 'user.local@yourcompany.dev';
    const record: DevAuthRecord = {
      role,
      email: (email || fallbackEmail).trim().toLowerCase()
    };

    this.setDevUser(record);
  }

  signInWithEmailPassword(emailInput: string, passwordInput: string): { ok: boolean; error?: string } {
    if (!this.isLocalAuthEnabled()) {
      return { ok: false, error: 'Email/password login is not enabled for this environment.' };
    }

    const email = emailInput.trim().toLowerCase();
    const password = passwordInput;
    if (!email || !password) {
      return { ok: false, error: 'Email and password are required.' };
    }

    const seededAccount = environment.auth.localUsers.find(user => user.email.trim().toLowerCase() === email);
    const customAccount = this.readLocalPasswordAccounts().find(user => user.email.trim().toLowerCase() === email);
    const account = customAccount || seededAccount;
    if (!account || account.password !== password) {
      return { ok: false, error: 'Invalid email or password.' };
    }

    const accountPhone = customAccount?.phone;
    this.setDevUser({
      role: account.role,
      email,
      displayName: account.displayName || undefined,
      phone: accountPhone || undefined,
      avatarUrl: account.avatarUrl || undefined
    }, {
      registered: customAccount ? !!customAccount.registered : true,
      canBootstrap: customAccount ? !customAccount.registered : false
    });

    return { ok: true };
  }

  createEmailPasswordAccount(
    emailInput: string,
    passwordInput: string,
    displayNameInput = '',
    phoneInput = ''
  ): { ok: boolean; error?: string } {
    if (!this.isLocalAuthEnabled()) {
      return { ok: false, error: 'Email/password account creation is not enabled for this environment yet. Use Microsoft or Google sign-in.' };
    }

    const email = emailInput.trim().toLowerCase();
    const password = passwordInput;
    const displayName = displayNameInput.trim();
    const phone = this.normalizePhone(phoneInput);

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { ok: false, error: 'Enter a valid email address.' };
    }
    if (displayName.length < 2) {
      return { ok: false, error: 'Enter your full name.' };
    }
    if (this.digitsOnly(phone).length < 10) {
      return { ok: false, error: 'Enter a valid phone number.' };
    }
    if (password.length < 8) {
      return { ok: false, error: 'Password must be at least 8 characters.' };
    }

    const seededExists = environment.auth.localUsers.some(user => user.email.trim().toLowerCase() === email);
    const customAccounts = this.readLocalPasswordAccounts();
    const customExists = customAccounts.some(user => user.email.trim().toLowerCase() === email);
    if (seededExists || customExists) {
      return { ok: false, error: 'An account with this email already exists. Try signing in.' };
    }

    customAccounts.push({
      email,
      password,
      role: 'admin',
      displayName: displayName || undefined,
      phone: phone || undefined,
      registered: false
    });
    this.writeLocalPasswordAccounts(customAccounts);

    this.setDevUser(
      {
        role: 'admin',
        email,
        displayName: displayName || undefined,
        phone: phone || undefined
      },
      {
        registered: false,
        canBootstrap: true
      }
    );

    return { ok: true };
  }

  async registerWorkspace(
    locationNamesInput: string[],
    billing?: RegistrationBillingPayload,
    planCycle: 'monthly' | 'annual' = 'monthly'
  ): Promise<{ ok: boolean; error?: string }> {
    const user = this.user();
    if (!user) {
      return { ok: false, error: 'Sign in before creating your workspace.' };
    }

    const locationNames = Array.from(new Set(
      (Array.isArray(locationNamesInput) ? locationNamesInput : [])
        .map(value => String(value || '').trim())
        .filter(Boolean)
    ));
    if (!locationNames.length) {
      return { ok: false, error: 'At least one location name is required.' };
    }

    try {
      if (this.stateSignal().source === 'dev') {
        const dev = this.readDevRecord();
        if (!dev) return { ok: false, error: 'No local account is active.' };

        const now = new Date();
        const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        const locations: AuthLocation[] = [];
        for (let index = 0; index < locationNames.length; index += 1) {
          const name = locationNames[index];
          const baseId = this.sanitizeTenantId(name) || `${DEFAULT_LOCATION_ID}-${index + 1}`;
          let nextId = baseId;
          let suffix = 2;
          while (locations.some(item => item.id === nextId)) {
            nextId = `${baseId}-${suffix++}`;
          }
          locations.push({ id: nextId, name });
        }
        const defaultLocationId = locations[0]?.id || DEFAULT_LOCATION_ID;
        this.setDevUser(
          {
            ...dev,
            role: 'admin'
          },
          {
            registered: true,
            canBootstrap: false,
            isSuperAdmin: true,
            locations,
            defaultLocationId,
            billingStatus: billing ? 'active' : 'trial',
            trialStartsAt: now.toISOString(),
            trialEndsAt: weekFromNow.toISOString(),
            accessLocked: false,
            accessLockReason: '',
            planCycle
          }
        );
        this.markLocalPasswordAccountRegistered(dev.email);
        return { ok: true };
      }

      const response = await fetch('/api/access', {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          op: 'bootstrap',
          locations: locationNames,
          locationName: locationNames[0],
          planCycle,
          billing: billing || null
        })
      });

      const payload = (await response.json()) as Partial<AccessProfileResponse> & { error?: string };
      if (!response.ok || !payload?.ok) {
        const detail = String(payload?.error || '').trim();
        return { ok: false, error: detail || 'Unable to complete registration right now.' };
      }

      await this.bootstrap(true);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Unable to complete registration right now.' };
    }
  }

  async updateBilling(
    billing: RegistrationBillingPayload,
    planCycle: 'monthly' | 'annual'
  ): Promise<{ ok: boolean; error?: string }> {
    const user = this.user();
    if (!user) return { ok: false, error: 'Sign in before updating billing.' };

    try {
      if (this.stateSignal().source === 'dev') {
        const access = this.accessSignal();
        this.accessSignal.set({
          ...access,
          billingStatus: this.digitsOnly(billing.cardNumber).startsWith('99999') ? 'sandbox' : 'active',
          accessLocked: false,
          accessLockReason: '',
          planCycle
        });
        return { ok: true };
      }

      const response = await fetch('/api/access', {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          op: 'update-billing',
          planCycle,
          billing
        })
      });

      const payload = (await response.json()) as Partial<AccessProfileResponse> & { error?: string };
      if (!response.ok || !payload?.ok) {
        const detail = String(payload?.error || '').trim();
        return { ok: false, error: detail || 'Unable to update billing right now.' };
      }

      await this.bootstrap(true);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Unable to update billing right now.' };
    }
  }

  async requestPasswordReset(emailInput: string, tenantId = ''): Promise<{ ok: boolean; error?: string; message?: string }> {
    const email = String(emailInput || '').trim().toLowerCase();
    if (!email) {
      return { ok: false, error: 'Email is required.' };
    }
    try {
      const response = await fetch('/api/access', {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          op: 'request-password-reset',
          email,
          tenantId: String(tenantId || '').trim()
        })
      });
      const payload = await response.json() as { ok?: boolean; error?: string; message?: string };
      if (!response.ok || !payload?.ok) {
        return { ok: false, error: String(payload?.error || 'Unable to start reset flow right now.') };
      }
      return { ok: true, message: String(payload.message || 'If that account exists, a reset email has been sent.') };
    } catch {
      return { ok: false, error: 'Unable to start reset flow right now.' };
    }
  }

  updateProfile(patch: { email?: string; avatarUrl?: string; displayName?: string }): { ok: boolean; error?: string } {
    const current = this.user();
    const source = this.stateSignal().source;
    if (!current || source === 'none') {
      return { ok: false, error: 'No active user profile to update.' };
    }

    const nextEmail = (patch.email ?? current.email).trim().toLowerCase();
    if (!nextEmail) {
      return { ok: false, error: 'Email is required.' };
    }

    const nextDisplayName = (patch.displayName ?? current.displayName).trim();
    const nextAvatarUrl = (patch.avatarUrl ?? current.avatarUrl ?? '').trim();

    const profileMap = this.readProfileMap();
    const previousEmail = (current.email || '').trim().toLowerCase();
    if (previousEmail && previousEmail !== nextEmail) {
      delete profileMap[previousEmail];
    }
    profileMap[nextEmail] = {
      displayName: nextDisplayName || undefined,
      avatarUrl: nextAvatarUrl || undefined
    };
    this.writeProfileMap(profileMap);

    if (source !== 'dev') {
      this.stateSignal.update(state => ({
        ...state,
        user: state.user ? this.applyProfileOverrides({ ...state.user, email: nextEmail }) : null
      }));
      return { ok: true };
    }

    const record: DevAuthRecord = {
      role: this.hasRole('admin') ? 'admin' : 'user',
      email: nextEmail,
      displayName: nextDisplayName || undefined,
      avatarUrl: nextAvatarUrl || undefined
    };

    this.setDevUser(record);
    return { ok: true };
  }

  clearDevUser(): void {
    localStorage.removeItem(DEV_AUTH_STORAGE_KEY);
  }

  async refresh(): Promise<void> {
    await this.bootstrap(true);
  }

  private async hydrateAuthState(): Promise<void> {
    const principal = await this.fetchClientPrincipal();

    if (principal) {
      const principalUser = this.principalToUser(principal);
      const access = await this.fetchAccessState();
      const user: AuthUser = this.applyProfileOverrides({
        ...principalUser,
        roles: this.mergeRoleLists(principalUser.roles, access.roles)
      });

      this.stateSignal.set({
        initialized: true,
        loading: false,
        source: 'swa',
        user
      });
      this.accessSignal.set(access.state);
      return;
    }

    if (this.isLocalAuthEnabled()) {
      const devRecord = this.readDevRecord();
      if (devRecord) {
        this.setDevUser(devRecord);
        return;
      }
    }

    this.stateSignal.set({
      initialized: true,
      loading: false,
      source: 'none',
      user: null
    });
    this.accessSignal.set(this.emptyAccessState(true));
  }

  private normalizeRedirect(path?: string, fallback = '/dashboard'): string {
    const candidate = (path || '').trim();
    if (!candidate.startsWith('/')) return fallback;
    if (candidate.startsWith('/.auth/')) return fallback;
    return candidate;
  }

  private async fetchClientPrincipal(): Promise<ClientPrincipal | null> {
    // Static Web Apps auth endpoint isn't available during local Angular dev.
    if (this.isLocalHost) {
      return null;
    }

    try {
      const response = await fetch('/.auth/me', {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json'
        }
      });

      if (!response.ok) return null;

      const payload = (await response.json()) as unknown;
      if (!payload) return null;

      if (this.isAuthMeResponse(payload)) {
        return payload.clientPrincipal ?? null;
      }

      if (Array.isArray(payload)) {
        const maybe = payload[0] as unknown;
        if (this.isAuthMeResponse(maybe)) return maybe.clientPrincipal ?? null;
      }

      return null;
    } catch {
      return null;
    }
  }

  private async fetchAccessState(): Promise<AccessHydrationResult> {
    try {
      const response = await fetch('/api/access?scope=me', {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json'
        }
      });

      const payload = (await response.json()) as AccessProfileResponse;
      if (!response.ok || !payload || !payload.ok) {
        return {
          roles: [],
          state: this.emptyAccessState(true, { registered: true })
        };
      }

      const profile = payload.profile || null;
      if (!profile) {
        return {
          roles: [],
          state: this.emptyAccessState(true, {
            registered: false,
            canBootstrap: !!payload.canBootstrap
          })
        };
      }

      const locations = this.normalizeLocations(profile.locations);
      const defaultLocationId = this.pickDefaultLocationId(profile.defaultLocationId, locations);
      return {
        roles: this.normalizeRoleList(profile.roles || []),
        state: {
          loaded: true,
          registered: true,
          canBootstrap: !!payload.canBootstrap,
          isSuperAdmin: !!profile.isSuperAdmin,
          locations,
          defaultLocationId,
          billingStatus: String(profile.billingStatus || '').trim().toLowerCase() || 'trial',
          trialStartsAt: String(profile.trialStartsAt || '').trim(),
          trialEndsAt: String(profile.trialEndsAt || '').trim(),
          accessLocked: !!profile.accessLocked,
          accessLockReason: String(profile.accessLockReason || '').trim(),
          planCycle: this.normalizePlanCycle(profile.planCycle)
        }
      };
    } catch {
      return {
        roles: [],
        state: this.emptyAccessState(true, { registered: true })
      };
    }
  }

  private principalToUser(principal: ClientPrincipal): AuthUser {
    const claims = Array.isArray(principal.claims) ? principal.claims : [];
    const emailClaim = claims.find(c => (c.typ || '').toLowerCase() === 'emails')?.val ||
      claims.find(c => (c.typ || '').toLowerCase() === 'email')?.val ||
      claims.find(c => (c.typ || '').toLowerCase() === 'preferred_username')?.val;

    const rawDetails = String(principal.userDetails || '').trim();
    const email = String(emailClaim || rawDetails).trim().toLowerCase();
    const displayName = rawDetails || email || 'Signed-in user';
    const roles = this.normalizeRoles(principal.userRoles || [], email);

    const baseUser: AuthUser = {
      id: String(principal.userId || email || crypto.randomUUID()),
      displayName,
      email,
      identityProvider: String(principal.identityProvider || 'unknown'),
      roles
    };

    return this.applyProfileOverrides(baseUser);
  }

  private normalizeRoles(input: string[], email: string): string[] {
    const out = new Set<string>();
    input
      .map(v => String(v || '').trim().toLowerCase())
      .filter(Boolean)
      .forEach(v => out.add(v));

    if (!out.has('authenticated')) {
      out.add('authenticated');
    }

    const adminEmails = environment.auth.adminEmails
      .map(v => v.trim().toLowerCase())
      .filter(Boolean);

    if (email && adminEmails.includes(email)) {
      out.add('admin');
    }

    return [...out];
  }

  private normalizeRoleList(input: string[]): string[] {
    const out = new Set<string>();
    for (const value of input) {
      const next = String(value || '').trim().toLowerCase();
      if (!next) continue;
      out.add(next);
    }
    if (!out.has('authenticated')) out.add('authenticated');
    return [...out];
  }

  private mergeRoleLists(...lists: string[][]): string[] {
    const out = new Set<string>();
    for (const list of lists) {
      for (const role of list) {
        const next = String(role || '').trim().toLowerCase();
        if (!next) continue;
        out.add(next);
      }
    }
    if (!out.has('authenticated')) out.add('authenticated');
    return [...out];
  }

  private normalizeLocations(input: Array<{ id?: string; name?: string }> | undefined): AuthLocation[] {
    const out: AuthLocation[] = [];
    const seen = new Set<string>();
    const values = Array.isArray(input) ? input : [];
    for (const item of values) {
      const id = this.sanitizeTenantId(item?.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = String(item?.name || '').trim() || this.humanizeTenantId(id);
      out.push({ id, name });
    }
    return out;
  }

  private pickDefaultLocationId(candidate: string | undefined, locations: AuthLocation[]): string {
    const normalized = this.sanitizeTenantId(candidate || '');
    if (normalized && locations.some(location => location.id === normalized)) {
      return normalized;
    }
    return locations[0]?.id || '';
  }

  private emptyAccessState(loaded: boolean, patch?: Partial<AuthAccessState>): AuthAccessState {
    return {
      loaded,
      registered: false,
      canBootstrap: false,
      isSuperAdmin: false,
      locations: [],
      defaultLocationId: '',
      billingStatus: 'trial',
      trialStartsAt: '',
      trialEndsAt: '',
      accessLocked: false,
      accessLockReason: '',
      planCycle: 'monthly',
      ...patch
    };
  }

  private sanitizeTenantId(value: string): string {
    return String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  private humanizeTenantId(tenantId: string): string {
    const value = String(tenantId || '').replace(/[-_]+/g, ' ').trim();
    if (!value) return 'Location';
    return value
      .split(/\s+/)
      .filter(Boolean)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  private readDevRecord(): DevAuthRecord | null {
    const raw = localStorage.getItem(DEV_AUTH_STORAGE_KEY);
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as Partial<DevAuthRecord>;
      const role = parsed.role === 'admin' ? 'admin' : parsed.role === 'user' ? 'user' : null;
      if (!role) return null;
      const email = String(parsed.email || '').trim().toLowerCase();
      if (!email) return null;
      const displayName = String(parsed.displayName || '').trim() || undefined;
      const phone = this.normalizePhone(String(parsed.phone || ''));
      const avatarUrl = String(parsed.avatarUrl || '').trim() || undefined;
      return { role, email, displayName, phone: phone || undefined, avatarUrl };
    } catch {
      return null;
    }
  }

  private devRecordToUser(record: DevAuthRecord): AuthUser {
    const roles = new Set<string>(['authenticated']);
    if (record.role === 'admin') roles.add('admin');
    const fallbackName = record.role === 'admin' ? 'Local Admin' : 'Local User';

    const baseUser: AuthUser = {
      id: `dev-${record.role}`,
      displayName: record.displayName || fallbackName,
      email: record.email,
      phone: this.normalizePhone(record.phone || '') || undefined,
      identityProvider: 'dev-local',
      roles: [...roles],
      avatarUrl: record.avatarUrl
    };

    return this.applyProfileOverrides(baseUser);
  }

  private setDevUser(record: DevAuthRecord, options?: DevSessionOptions): void {
    localStorage.setItem(DEV_AUTH_STORAGE_KEY, JSON.stringify(record));
    const user = this.devRecordToUser(record);
    this.stateSignal.set({
      initialized: true,
      loading: false,
      source: 'dev',
      user
    });
    const registered = options?.registered ?? true;
    const locationList = Array.isArray(options?.locations)
      ? options.locations.filter(location => !!location?.id)
      : [{ id: DEFAULT_LOCATION_ID, name: DEFAULT_LOCATION_NAME }];
    const defaultLocation: AuthLocation = locationList[0] || { id: DEFAULT_LOCATION_ID, name: DEFAULT_LOCATION_NAME };
    this.accessSignal.set({
      loaded: true,
      registered,
      canBootstrap: options?.canBootstrap ?? !registered,
      isSuperAdmin: options?.isSuperAdmin ?? user.roles.includes('admin'),
      locations: registered ? locationList : [],
      defaultLocationId: registered ? (options?.defaultLocationId || defaultLocation.id) : '',
      billingStatus: options?.billingStatus || 'trial',
      trialStartsAt: options?.trialStartsAt || '',
      trialEndsAt: options?.trialEndsAt || '',
      accessLocked: !!options?.accessLocked,
      accessLockReason: options?.accessLockReason || '',
      planCycle: options?.planCycle || 'monthly'
    });
  }

  private isLocalAuthEnabled(): boolean {
    return environment.auth.devBypass || environment.auth.localPasswordEnabled || this.isLocalHost;
  }

  private normalizePlanCycle(value: unknown): 'monthly' | 'annual' {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'annual' ? 'annual' : 'monthly';
  }

  private digitsOnly(value: unknown): string {
    return String(value ?? '').replace(/\D+/g, '');
  }

  private normalizePhone(value: unknown): string {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const digits = this.digitsOnly(raw);
    if (!digits) return '';
    if (digits.length === 10) {
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    if (digits.length === 11 && digits.startsWith('1')) {
      return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    return raw;
  }

  private applyProfileOverrides(user: AuthUser): AuthUser {
    const email = (user.email || '').trim().toLowerCase();
    if (!email) return user;

    const map = this.readProfileMap();
    const profile = map[email];
    if (!profile) return user;

    return {
      ...user,
      displayName: (profile.displayName || user.displayName || '').trim() || user.displayName,
      avatarUrl: (profile.avatarUrl || user.avatarUrl || '').trim() || undefined
    };
  }

  private readProfileMap(): Record<string, { displayName?: string; avatarUrl?: string }> {
    const raw = localStorage.getItem(AUTH_PROFILE_STORAGE_KEY);
    if (!raw) return {};

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return {};
      return parsed as Record<string, { displayName?: string; avatarUrl?: string }>;
    } catch {
      return {};
    }
  }

  private writeProfileMap(map: Record<string, { displayName?: string; avatarUrl?: string }>): void {
    localStorage.setItem(AUTH_PROFILE_STORAGE_KEY, JSON.stringify(map));
  }

  private readLocalPasswordAccounts(): LocalPasswordAccount[] {
    const raw = localStorage.getItem(LOCAL_PASSWORD_ACCOUNTS_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const out: LocalPasswordAccount[] = [];
      for (const item of parsed) {
        const row = item as Partial<LocalPasswordAccount>;
        const email = String(row.email || '').trim().toLowerCase();
        const password = String(row.password || '');
        const role = row.role === 'user' ? 'user' : 'admin';
        if (!email || !password) continue;
        out.push({
          email,
          password,
          role,
          displayName: String(row.displayName || '').trim() || undefined,
          phone: this.normalizePhone(String(row.phone || '')) || undefined,
          avatarUrl: String(row.avatarUrl || '').trim() || undefined,
          registered: row.registered !== false
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  private writeLocalPasswordAccounts(accounts: LocalPasswordAccount[]): void {
    localStorage.setItem(LOCAL_PASSWORD_ACCOUNTS_KEY, JSON.stringify(accounts));
  }

  private markLocalPasswordAccountRegistered(emailInput: string): void {
    const email = String(emailInput || '').trim().toLowerCase();
    if (!email) return;
    const accounts = this.readLocalPasswordAccounts();
    let touched = false;
    for (const account of accounts) {
      if (account.email !== email) continue;
      if (account.registered) break;
      account.registered = true;
      touched = true;
      break;
    }
    if (touched) {
      this.writeLocalPasswordAccounts(accounts);
    }
  }

  private isAuthMeResponse(payload: unknown): payload is AuthMeResponse {
    if (!payload || typeof payload !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(payload, 'clientPrincipal');
  }
}
