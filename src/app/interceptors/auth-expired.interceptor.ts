import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../auth/auth.service';

export const authExpiredInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  if (!isApiRequest(req.url) || isAuthBootstrapRequest(req.url)) return next(req);

  return next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse && err.status === 401 && auth.isAuthenticated()) {
        void auth.recheckSession().then(() => {
          if (auth.isAuthenticated() || auth.sessionCheckFailed() || router.url.startsWith('/login')) return;
          return router.navigate(['/login'], { queryParams: { redirect: router.url }, replaceUrl: true });
        });
      }
      return throwError(() => err);
    })
  );
};

function isApiRequest(url: string): boolean {
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'https://localhost');
    return parsed.pathname.startsWith('/api/');
  } catch {
    return String(url || '').startsWith('/api/');
  }
}

function isAuthBootstrapRequest(url: string): boolean {
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'https://localhost');
    if (parsed.pathname !== '/api/access') return false;
    const op = String(parsed.searchParams.get('op') || '').trim().toLowerCase();
    const scope = String(parsed.searchParams.get('scope') || '').trim().toLowerCase();
    return op === 'auth-config' || scope === 'me';
  } catch {
    const raw = String(url || '').toLowerCase();
    return raw.includes('/api/access?op=auth-config') || raw.includes('/api/access?scope=me');
  }
}
