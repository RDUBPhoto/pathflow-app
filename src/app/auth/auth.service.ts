import { Injectable, computed, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import { AuthMeResponse, AuthState, AuthUser, ClientPrincipal } from './auth.models';

const DEV_AUTH_STORAGE_KEY = 'exodus.dev.auth.user';
const AUTH_PROFILE_STORAGE_KEY = 'exodus.auth.profile';

interface DevAuthRecord {
  role: 'admin' | 'user';
  email: string;
  displayName?: string;
  avatarUrl?: string;
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

  private bootstrapping: Promise<void> | null = null;

  readonly state = computed(() => this.stateSignal());
  readonly initialized = computed(() => this.stateSignal().initialized);
  readonly loading = computed(() => this.stateSignal().loading);
  readonly user = computed(() => this.stateSignal().user);
  readonly isAuthenticated = computed(() => this.stateSignal().user !== null);
  readonly isAdmin = computed(() => this.hasRole('admin'));

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

    this.bootstrapping = this.hydrateAuthState()
      .catch(() => {
        this.stateSignal.set({
          initialized: true,
          loading: false,
          source: 'none',
          user: null
        });
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

    const target = this.normalizeRedirect(redirectTo, '/login');
    if (source === 'dev') {
      window.location.assign(target);
      return;
    }

    window.location.assign(`/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(target)}`);
  }

  signInDev(role: 'admin' | 'user', email?: string): void {
    const fallbackEmail = role === 'admin' ? 'admin.local@exodus4x4.dev' : 'user.local@exodus4x4.dev';
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

    const account = environment.auth.localUsers.find(user => user.email.trim().toLowerCase() === email);
    if (!account || account.password !== password) {
      return { ok: false, error: 'Invalid email or password.' };
    }

    this.setDevUser({
      role: account.role,
      email,
      displayName: account.displayName || undefined,
      avatarUrl: account.avatarUrl || undefined
    });

    return { ok: true };
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
      this.stateSignal.set({
        initialized: true,
        loading: false,
        source: 'swa',
        user: this.principalToUser(principal)
      });
      return;
    }

    if (this.isLocalAuthEnabled()) {
      const devRecord = this.readDevRecord();
      if (devRecord) {
        this.stateSignal.set({
          initialized: true,
          loading: false,
          source: 'dev',
          user: this.devRecordToUser(devRecord)
        });
        return;
      }
    }

    this.stateSignal.set({
      initialized: true,
      loading: false,
      source: 'none',
      user: null
    });
  }

  private normalizeRedirect(path?: string, fallback = '/dashboard'): string {
    const candidate = (path || '').trim();
    if (!candidate.startsWith('/')) return fallback;
    if (candidate.startsWith('/.auth/')) return fallback;
    return candidate;
  }

  private async fetchClientPrincipal(): Promise<ClientPrincipal | null> {
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
      const avatarUrl = String(parsed.avatarUrl || '').trim() || undefined;
      return { role, email, displayName, avatarUrl };
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
      identityProvider: 'dev-local',
      roles: [...roles],
      avatarUrl: record.avatarUrl
    };

    return this.applyProfileOverrides(baseUser);
  }

  private setDevUser(record: DevAuthRecord): void {
    localStorage.setItem(DEV_AUTH_STORAGE_KEY, JSON.stringify(record));
    const user = this.devRecordToUser(record);
    this.stateSignal.set({
      initialized: true,
      loading: false,
      source: 'dev',
      user
    });
  }

  private isLocalAuthEnabled(): boolean {
    return environment.auth.devBypass || environment.auth.localPasswordEnabled || this.isLocalHost;
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

  private isAuthMeResponse(payload: unknown): payload is AuthMeResponse {
    if (!payload || typeof payload !== 'object') return false;
    return Object.prototype.hasOwnProperty.call(payload, 'clientPrincipal');
  }
}
