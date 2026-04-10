import { Injectable, computed, signal } from '@angular/core';
import { environment } from '../../environments/environment';
import { formatUsPhoneInput, phoneDigits } from '../utils/phone-format';
import {
  AccessProfileResponse,
  AuthAccessState,
  AuthLocation,
  AuthState,
  AuthUser
} from './auth.models';

const DEV_AUTH_STORAGE_KEY = 'pathflow.dev.auth.user';
const AUTH_PROFILE_STORAGE_KEY = 'pathflow.auth.profile';
const LOCAL_PASSWORD_ACCOUNTS_KEY = 'pathflow.local.password.accounts';
const LOCAL_PASSKEYS_KEY = 'pathflow.local.passkeys';
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
  isSuperAdmin?: boolean;
  displayName?: string;
  phone?: string;
  avatarUrl?: string;
  registered?: boolean;
}

interface LocalPasskeyCredential {
  email: string;
  credentialId: string;
  createdAt: string;
  transports?: AuthenticatorTransport[];
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
  principal: {
    userId: string;
    email: string;
    displayName: string;
    identityProvider: string;
  } | null;
}

interface AuthRuntimeConfig {
  primaryProvider: string;
  providers: string[];
  hostedEmailEnabled: boolean;
  hostedEmailProvider: string;
  localPasswordEnabled: boolean;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  private readonly authConfigSignal = signal<AuthRuntimeConfig>(this.buildAuthRuntimeConfigFromEnvironment());
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
  readonly authConfig = computed(() => this.authConfigSignal());
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

    this.bootstrapping = this.hydrateRuntimeAuthConfig()
      .then(() => this.hydrateAuthState())
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
    const config = this.authConfigSignal();
    const requestedProvider = (provider || config.primaryProvider || 'aad').trim().toLowerCase();
    const allowedProviders = new Set<string>();
    const primary = (config.primaryProvider || 'aad').trim().toLowerCase() || 'aad';
    allowedProviders.add(primary);
    for (const item of config.providers || []) {
      const normalized = String(item || '').trim();
      if (normalized) allowedProviders.add(normalized);
    }
    if (config.hostedEmailEnabled) {
      const hosted = String(config.hostedEmailProvider || '').trim();
      if (hosted) allowedProviders.add(hosted);
    }
    const selectedProvider = allowedProviders.has(requestedProvider) ? requestedProvider : primary;
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
    const finalizeRedirect = () => {
      if (source !== 'swa') {
        window.location.assign(target);
        return;
      }
      window.location.assign(`/.auth/logout?post_logout_redirect_uri=${encodeURIComponent(target)}`);
    };

    void fetch('/api/access', {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ op: 'logout' })
    })
      .catch(() => undefined)
      .finally(finalizeRedirect);
  }

  signInDev(role: 'admin' | 'user', email?: string): void {
    const fallbackEmail = role === 'admin' ? 'admin.local@yourcompany.dev' : 'user.local@yourcompany.dev';
    const record: DevAuthRecord = {
      role,
      email: (email || fallbackEmail).trim().toLowerCase()
    };

    this.setDevUser(record);
  }

  signInDevSuperAdmin(email = 'superadmin.local@yourcompany.dev'): void {
    const record: DevAuthRecord = {
      role: 'admin',
      email: (email || 'superadmin.local@yourcompany.dev').trim().toLowerCase(),
      displayName: 'Local Super Admin'
    };

    this.setDevUser(record, {
      isSuperAdmin: true,
      registered: true,
      canBootstrap: false,
      billingStatus: 'active',
      accessLocked: false
    });
  }

  async signInWithEmailPassword(emailInput: string, passwordInput: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isLocalAuthEnabled()) {
      return { ok: false, error: 'Email/password login is not enabled for this environment.' };
    }

    const email = emailInput.trim().toLowerCase();
    const password = passwordInput;
    if (!email || !password) {
      return { ok: false, error: 'Email and password are required.' };
    }

    if (!this.isLocalHost || this.authConfigSignal().localPasswordEnabled) {
      try {
        const response = await fetch('/api/access', {
          method: 'POST',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            op: 'password-login',
            email,
            password
          })
        });
        const payload = await response.json() as { ok?: boolean; error?: string };
        if (!response.ok || !payload?.ok) {
          return { ok: false, error: String(payload?.error || 'Invalid email or password.') };
        }
        await this.bootstrap(true);
        return { ok: true };
      } catch {
        return { ok: false, error: 'Unable to sign in right now. Please try again.' };
      }
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
      canBootstrap: customAccount ? !customAccount.registered : false,
      isSuperAdmin: !!account.isSuperAdmin,
      billingStatus: account.isSuperAdmin ? 'active' : undefined,
      accessLocked: false
    });

    return { ok: true };
  }

  async signInWithPasskey(emailInput: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.isLocalAuthEnabled()) {
      return { ok: false, error: 'Passkey login is only available for email/password workspaces in this build.' };
    }
    if (!this.isPasskeySupported()) {
      return { ok: false, error: 'Passkeys are not supported on this browser/device.' };
    }

    const email = emailInput.trim().toLowerCase();
    if (!email) {
      return { ok: false, error: 'Enter your email to use biometric sign-in.' };
    }

    const account = this.resolveLocalPasswordAccount(email);
    if (!account) {
      return { ok: false, error: 'No account found for this email.' };
    }

    const passkeys = this.readLocalPasskeys().filter(item => item.email === email);
    if (!passkeys.length) {
      return { ok: false, error: 'No passkey is set for this account yet.' };
    }

    try {
      const challenge = this.createChallenge();
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          allowCredentials: passkeys
            .map(item => this.base64UrlToBytes(item.credentialId))
            .filter((id): id is Uint8Array => !!id)
            .map(id => ({ type: 'public-key' as const, id })),
          userVerification: 'required',
          timeout: 60000,
          rpId: window.location.hostname
        }
      });

      const credential = assertion as PublicKeyCredential | null;
      if (!credential) {
        return { ok: false, error: 'Biometric sign-in was cancelled.' };
      }

      const credentialId = this.bytesToBase64Url(new Uint8Array(credential.rawId));
      const matched = passkeys.some(item => item.credentialId === credentialId);
      if (!matched) {
        return { ok: false, error: 'Passkey verification failed. Try again.' };
      }

      this.setDevUser({
        role: account.role,
        email,
        displayName: account.displayName || undefined,
        phone: account.phone || undefined,
        avatarUrl: account.avatarUrl || undefined
      }, {
        registered: account.registered !== false,
        canBootstrap: account.registered === false,
        isSuperAdmin: !!account.isSuperAdmin,
        billingStatus: account.isSuperAdmin ? 'active' : undefined,
        accessLocked: false
      });

      return { ok: true };
    } catch {
      return { ok: false, error: 'Biometric sign-in was cancelled or unavailable.' };
    }
  }

  async registerPasskeyForCurrentUser(): Promise<{ ok: boolean; error?: string; message?: string }> {
    if (!this.isLocalAuthEnabled()) {
      return { ok: false, error: 'Passkeys are only available for email/password workspaces in this build.' };
    }
    if (!this.isPasskeySupported()) {
      return { ok: false, error: 'Passkeys are not supported on this browser/device.' };
    }

    const currentEmail = String(this.user()?.email || '').trim().toLowerCase();
    if (!currentEmail) {
      return { ok: false, error: 'Sign in first, then enable passkeys.' };
    }
    const account = this.resolveLocalPasswordAccount(currentEmail);
    if (!account) {
      return { ok: false, error: 'This account does not support local passkeys.' };
    }

    try {
      const challenge = this.createChallenge();
      const userId = this.createUserIdBytes(currentEmail);
      const displayName = account.displayName || currentEmail;
      const created = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: {
            name: 'Pathflow',
            id: window.location.hostname
          },
          user: {
            id: userId,
            name: currentEmail,
            displayName
          },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 }
          ],
          authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'required'
          },
          timeout: 60000,
          attestation: 'none'
        }
      });

      const credential = created as PublicKeyCredential | null;
      if (!credential) {
        return { ok: false, error: 'Passkey setup was cancelled.' };
      }

      const credentialId = this.bytesToBase64Url(new Uint8Array(credential.rawId));
      const transports = this.extractTransports(credential);
      const existing = this.readLocalPasskeys().filter(
        item => !(item.email === currentEmail && item.credentialId === credentialId)
      );
      existing.push({
        email: currentEmail,
        credentialId,
        createdAt: new Date().toISOString(),
        transports
      });
      this.writeLocalPasskeys(existing);

      return { ok: true, message: 'Passkey enabled. You can now sign in with biometrics.' };
    } catch {
      return { ok: false, error: 'Passkey setup was cancelled or unavailable.' };
    }
  }

  removePasskeysForCurrentUser(): { ok: boolean; message?: string; error?: string } {
    const currentEmail = String(this.user()?.email || '').trim().toLowerCase();
    if (!currentEmail) {
      return { ok: false, error: 'Sign in first, then manage passkeys.' };
    }
    const all = this.readLocalPasskeys();
    const next = all.filter(item => item.email !== currentEmail);
    this.writeLocalPasskeys(next);
    return { ok: true, message: 'Saved passkeys removed for this account.' };
  }

  hasPasskeyForEmail(emailInput: string): boolean {
    const email = String(emailInput || '').trim().toLowerCase();
    if (!email) return false;
    return this.readLocalPasskeys().some(item => item.email === email);
  }

  hasPasskeyForCurrentUser(): boolean {
    const email = String(this.user()?.email || '').trim().toLowerCase();
    if (!email) return false;
    return this.hasPasskeyForEmail(email);
  }

  isPasskeySupported(): boolean {
    if (!this.isLocalHost && !environment.auth.devBypass) {
      return false;
    }
    return typeof window !== 'undefined' &&
      window.isSecureContext &&
      typeof window.PublicKeyCredential !== 'undefined' &&
      typeof navigator !== 'undefined' &&
      !!navigator.credentials &&
      typeof navigator.credentials.create === 'function' &&
      typeof navigator.credentials.get === 'function';
  }

  isLocalPasswordAuthEnabled(): boolean {
    return this.isLocalAuthEnabled();
  }

  isProviderEnabled(provider: string): boolean {
    const normalized = String(provider || '').trim().toLowerCase();
    if (!normalized) return false;
    return this.authConfigSignal().providers.includes(normalized);
  }

  primaryAuthProvider(): string {
    return this.authConfigSignal().primaryProvider;
  }

  isHostedEmailEnabled(): boolean {
    const config = this.authConfigSignal();
    return !config.localPasswordEnabled && !!config.hostedEmailEnabled && !!config.hostedEmailProvider;
  }

  hostedEmailProvider(): string {
    return this.authConfigSignal().hostedEmailProvider;
  }

  async createEmailPasswordAccount(
    emailInput: string,
    passwordInput: string,
    displayNameInput = '',
    phoneInput = ''
  ): Promise<{ ok: boolean; error?: string }> {
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

    if (!this.isLocalHost || this.authConfigSignal().localPasswordEnabled) {
      try {
        const response = await fetch('/api/access', {
          method: 'POST',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            op: 'password-signup',
            email,
            password,
            displayName,
            phone
          })
        });
        const payload = await response.json() as { ok?: boolean; error?: string };
        if (!response.ok || !payload?.ok) {
          return { ok: false, error: String(payload?.error || 'Unable to create your account right now.') };
        }
        await this.bootstrap(true);
        return { ok: true };
      } catch {
        return { ok: false, error: 'Unable to create your account right now.' };
      }
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
    const access = await this.fetchAccessState();
    if (access.principal) {
      const principalUser = this.accessPrincipalToUser(access.principal, access.roles);
      this.stateSignal.set({
        initialized: true,
        loading: false,
        source: this.resolveSourceFromIdentityProvider(access.principal.identityProvider),
        user: this.applyProfileOverrides(principalUser)
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

  private async hydrateRuntimeAuthConfig(): Promise<void> {
    const fallback = this.buildAuthRuntimeConfigFromEnvironment();
    try {
      const response = await fetch('/api/access?op=auth-config', {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json'
        }
      });
      if (!response.ok) {
        this.authConfigSignal.set(fallback);
        return;
      }
      const payload = await response.json() as { ok?: boolean; config?: unknown };
      if (!payload?.ok) {
        this.authConfigSignal.set(fallback);
        return;
      }
      const runtimeConfig = this.coerceAuthRuntimeConfig(payload.config);
      this.authConfigSignal.set(runtimeConfig || fallback);
    } catch {
      this.authConfigSignal.set(fallback);
    }
  }

  private normalizeRedirect(path?: string, fallback = '/dashboard'): string {
    const candidate = (path || '').trim();
    if (!candidate.startsWith('/')) return fallback;
    if (candidate.startsWith('/.auth/')) return fallback;
    return candidate;
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
          state: this.emptyAccessState(true, { registered: false, canBootstrap: false }),
          principal: null
        };
      }

      const principal = this.normalizeAccessPrincipal(payload.principal);
      const profile = payload.profile || null;
      if (!profile) {
        return {
          roles: [],
          state: this.emptyAccessState(true, {
            registered: false,
            canBootstrap: !!payload.canBootstrap
          }),
          principal
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
        },
        principal
      };
    } catch {
      return {
        roles: [],
        state: this.emptyAccessState(true, { registered: false, canBootstrap: false }),
        principal: null
      };
    }
  }

  private normalizeAccessPrincipal(input: AccessProfileResponse['principal']): AccessHydrationResult['principal'] {
    if (!input || typeof input !== 'object') return null;
    const userId = String(input.userId || '').trim();
    const email = String(input.email || '').trim().toLowerCase();
    const displayName = String(input.displayName || '').trim();
    const identityProvider = String(input.identityProvider || '').trim();
    if (!userId && !email) return null;
    return {
      userId: userId || email,
      email,
      displayName: displayName || email || userId || 'Signed-in user',
      identityProvider: identityProvider || 'unknown'
    };
  }

  private accessPrincipalToUser(
    principal: NonNullable<AccessHydrationResult['principal']>,
    roles: string[]
  ): AuthUser {
    return {
      id: principal.userId || principal.email || crypto.randomUUID(),
      displayName: principal.displayName || principal.email || 'Signed-in user',
      email: principal.email,
      identityProvider: principal.identityProvider || 'unknown',
      roles: this.normalizeRoleList(Array.isArray(roles) ? roles : [])
    };
  }

  private resolveSourceFromIdentityProvider(identityProviderInput: string): AuthState['source'] {
    const identityProvider = String(identityProviderInput || '').trim().toLowerCase();
    if (identityProvider === 'dev-local') return 'dev';
    if (!identityProvider) return 'session';
    if (
      identityProvider.startsWith('app-') ||
      identityProvider === 'session' ||
      identityProvider === 'local'
    ) {
      return 'session';
    }
    return 'swa';
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
    return environment.auth.devBypass || this.authConfigSignal().localPasswordEnabled || this.isLocalHost;
  }

  private buildAuthRuntimeConfigFromEnvironment(): AuthRuntimeConfig {
    const primaryProvider = String(environment.auth.primaryProvider || 'aad').trim().toLowerCase() || 'aad';
    const providers = new Set<string>();
    providers.add(primaryProvider);
    for (const item of environment.auth.providers || []) {
      const normalized = String(item || '').trim().toLowerCase();
      if (!normalized) continue;
      providers.add(normalized);
    }

    const hostedEmailProvider = String(environment.auth.hostedEmailProvider || '').trim().toLowerCase();
    const hostedEmailEnabled = !!environment.auth.hostedEmailEnabled && !!hostedEmailProvider;
    if (hostedEmailEnabled) {
      providers.add(hostedEmailProvider);
    }

    return {
      primaryProvider,
      providers: Array.from(providers),
      hostedEmailEnabled,
      hostedEmailProvider: hostedEmailEnabled ? hostedEmailProvider : '',
      localPasswordEnabled: !!environment.auth.localPasswordEnabled
    };
  }

  private coerceAuthRuntimeConfig(input: unknown): AuthRuntimeConfig | null {
    const fallback = this.buildAuthRuntimeConfigFromEnvironment();
    if (!input || typeof input !== 'object') return null;
    const raw = input as Partial<AuthRuntimeConfig>;
    const primaryProvider = String(raw.primaryProvider || fallback.primaryProvider).trim().toLowerCase() || fallback.primaryProvider;
    const providers = new Set<string>();
    providers.add(primaryProvider);
    for (const item of Array.isArray(raw.providers) ? raw.providers : fallback.providers) {
      const normalized = String(item || '').trim().toLowerCase();
      if (!normalized) continue;
      providers.add(normalized);
    }
    const hostedEmailProvider = String(raw.hostedEmailProvider || '').trim().toLowerCase();
    const hostedEmailEnabled = !!raw.hostedEmailEnabled && !!hostedEmailProvider;
    if (hostedEmailEnabled) {
      providers.add(hostedEmailProvider);
    }
    return {
      primaryProvider,
      providers: Array.from(providers),
      hostedEmailEnabled,
      hostedEmailProvider: hostedEmailEnabled ? hostedEmailProvider : '',
      localPasswordEnabled: !!raw.localPasswordEnabled
    };
  }

  private normalizePlanCycle(value: unknown): 'monthly' | 'annual' {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === 'annual' ? 'annual' : 'monthly';
  }

  private digitsOnly(value: unknown): string {
    return phoneDigits(value);
  }

  private normalizePhone(value: unknown): string {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const digits = this.digitsOnly(raw);
    if (!digits) return '';
    if (digits.length >= 10 && digits.length <= 11) {
      return formatUsPhoneInput(digits);
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

  private resolveLocalPasswordAccount(emailInput: string): LocalPasswordAccount | null {
    const email = String(emailInput || '').trim().toLowerCase();
    if (!email) return null;
    const custom = this.readLocalPasswordAccounts().find(user => user.email.trim().toLowerCase() === email);
    if (custom) return custom;
    const seeded = environment.auth.localUsers.find(user => user.email.trim().toLowerCase() === email);
    if (!seeded) return null;
    return {
      email: seeded.email.trim().toLowerCase(),
      password: seeded.password,
      role: seeded.role,
      isSuperAdmin: !!seeded.isSuperAdmin,
      displayName: seeded.displayName || undefined,
      avatarUrl: seeded.avatarUrl || undefined,
      phone: seeded.phone || undefined,
      registered: true
    };
  }

  private createChallenge(size = 32): Uint8Array {
    const bytes = new Uint8Array(size);
    crypto.getRandomValues(bytes);
    return bytes;
  }

  private createUserIdBytes(email: string): Uint8Array {
    const source = String(email || '').trim().toLowerCase().slice(0, 64);
    return new TextEncoder().encode(source || crypto.randomUUID());
  }

  private bytesToBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  private base64UrlToBytes(value: string): Uint8Array | null {
    const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    if (!normalized) return null;
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    try {
      const binary = atob(padded);
      const out = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        out[i] = binary.charCodeAt(i);
      }
      return out;
    } catch {
      return null;
    }
  }

  private readLocalPasskeys(): LocalPasskeyCredential[] {
    const raw = localStorage.getItem(LOCAL_PASSKEYS_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const out: LocalPasskeyCredential[] = [];
      for (const item of parsed) {
        const row = item as Partial<LocalPasskeyCredential>;
        const email = String(row.email || '').trim().toLowerCase();
        const credentialId = String(row.credentialId || '').trim();
        if (!email || !credentialId) continue;
        const transports = Array.isArray(row.transports)
          ? row.transports
            .map(value => this.normalizeAuthenticatorTransport(value))
            .filter((value): value is AuthenticatorTransport => !!value)
          : undefined;
        out.push({
          email,
          credentialId,
          createdAt: String(row.createdAt || '').trim() || new Date().toISOString(),
          transports
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  private writeLocalPasskeys(passkeys: LocalPasskeyCredential[]): void {
    localStorage.setItem(LOCAL_PASSKEYS_KEY, JSON.stringify(passkeys));
  }

  private extractTransports(credential: PublicKeyCredential): AuthenticatorTransport[] | undefined {
    const response = credential.response as AuthenticatorAttestationResponse | null;
    if (!response || typeof response.getTransports !== 'function') return undefined;
    const transports = response
      .getTransports()
      .map(value => this.normalizeAuthenticatorTransport(value))
      .filter((value): value is AuthenticatorTransport => !!value);
    return transports.length ? transports : undefined;
  }

  private normalizeAuthenticatorTransport(value: unknown): AuthenticatorTransport | null {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'ble') return 'ble';
    if (raw === 'hybrid') return 'hybrid';
    if (raw === 'internal') return 'internal';
    if (raw === 'nfc') return 'nfc';
    if (raw === 'usb') return 'usb';
    return null;
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

}
