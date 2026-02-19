export type AuthSource = 'none' | 'swa' | 'dev';

export interface AuthUser {
  id: string;
  displayName: string;
  email: string;
  identityProvider: string;
  roles: string[];
  avatarUrl?: string;
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
