export type AuthSource = 'none' | 'swa' | 'dev';

export interface AuthUser {
  id: string;
  displayName: string;
  email: string;
  phone?: string;
  identityProvider: string;
  roles: string[];
  avatarUrl?: string;
}

export interface AuthLocation {
  id: string;
  name: string;
}

export interface AuthAccessState {
  loaded: boolean;
  registered: boolean;
  canBootstrap: boolean;
  isSuperAdmin: boolean;
  locations: AuthLocation[];
  defaultLocationId: string;
  billingStatus: string;
  trialStartsAt: string;
  trialEndsAt: string;
  accessLocked: boolean;
  accessLockReason: string;
  planCycle: 'monthly' | 'annual';
}

export interface AuthState {
  initialized: boolean;
  loading: boolean;
  source: AuthSource;
  user: AuthUser | null;
}

export interface ClientPrincipalClaim {
  typ?: string;
  val?: string;
}

export interface ClientPrincipal {
  identityProvider?: string;
  userId?: string;
  userDetails?: string;
  userRoles?: string[];
  claims?: ClientPrincipalClaim[];
}

export interface AuthMeResponse {
  clientPrincipal?: ClientPrincipal | null;
}

export interface AccessProfileResponse {
  ok: boolean;
  canBootstrap?: boolean;
  profile?: {
    roles?: string[];
    isSuperAdmin?: boolean;
    locations?: Array<{ id?: string; name?: string }>;
    defaultLocationId?: string;
    billingStatus?: string;
    trialStartsAt?: string;
    trialEndsAt?: string;
    accessLocked?: boolean;
    accessLockReason?: string;
    planCycle?: 'monthly' | 'annual' | string;
  } | null;
}
