import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { TenantContextService } from '../services/tenant-context.service';
import { AuthService } from '../auth/auth.service';

export const tenantHeaderInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isApiRequest(req.url)) {
    return next(req);
  }

  const tenant = inject(TenantContextService).tenantId();
  const auth = inject(AuthService);
  const user = auth.user();
  const headers: Record<string, string> = {};

  if (!req.headers.has('x-tenant-id')) {
    headers['x-tenant-id'] = tenant;
  }

  // Local Angular dev does not provide SWA principal headers, so pass a
  // dev-only identity envelope for local Functions.
  if (isLocalHost() && user && !req.headers.has('x-ms-client-principal')) {
    headers['x-dev-user-email'] = user.email || '';
    headers['x-dev-user-name'] = user.displayName || user.email || '';
    headers['x-dev-user-id'] = user.id || user.email || '';
    headers['x-dev-user-roles'] = Array.isArray(user.roles) ? user.roles.join(',') : 'authenticated';
  }

  if (!Object.keys(headers).length) return next(req);
  return next(req.clone({ setHeaders: headers }));
};

function isApiRequest(url: string): boolean {
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'https://wonderful-glacier-0f45f5110.6.azurestaticapps.net');
    return parsed.pathname.startsWith('/api/');
  } catch {
    return String(url || '').startsWith('/api/');
  }
}

function isLocalHost(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
}
