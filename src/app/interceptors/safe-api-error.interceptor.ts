import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';

export const safeApiErrorInterceptor: HttpInterceptorFn = (req, next) => {
  return next(req).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse)) {
        console.error('[api-error] Non-HTTP error', { url: req.url, method: req.method, error: err });
        return throwError(() => err);
      }

      if (!isApiRequest(req.url)) {
        return throwError(() => err);
      }

      const friendly = deriveFriendlyMessage(err.status);
      console.error('[api-error]', {
        url: req.url,
        method: req.method,
        status: err.status,
        statusText: err.statusText,
        response: err.error
      });

      const safeError = new HttpErrorResponse({
        error: {
          error: friendly
        },
        headers: err.headers,
        status: err.status,
        statusText: err.statusText,
        url: err.url || req.url
      });

      return throwError(() => safeError);
    })
  );
};

function deriveFriendlyMessage(status: number): string {
  if (status === 0) return 'Network unavailable. Check your internet connection and try again.';
  if (status === 400) return 'We could not process that request. Please check your input and try again.';
  if (status === 401) return 'Your session expired. Please sign in again.';
  if (status === 403) return 'You do not have permission to do that.';
  if (status === 404) return 'That information is unavailable right now.';
  if (status === 409) return 'This action could not be completed due to a conflict. Please refresh and try again.';
  if (status === 429) return 'Too many requests. Please wait a moment and try again.';
  if (status >= 500) return 'Something went wrong on our side. Please try again.';
  return 'Something went wrong. Please try again.';
}

function isApiRequest(url: string): boolean {
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'https://localhost');
    return parsed.pathname.startsWith('/api/');
  } catch {
    return String(url || '').startsWith('/api/');
  }
}
