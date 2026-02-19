import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { TenantContextService } from '../services/tenant-context.service';

export const tenantHeaderInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isApiRequest(req.url) || req.headers.has('x-tenant-id')) {
    return next(req);
  }

  const tenant = inject(TenantContextService).tenantId();
  return next(req.clone({
    setHeaders: {
      'x-tenant-id': tenant
    }
  }));
};

function isApiRequest(url: string): boolean {
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'https://app.pathflow.com');
    return parsed.pathname.startsWith('/api/');
  } catch {
    return String(url || '').startsWith('/api/');
  }
}
