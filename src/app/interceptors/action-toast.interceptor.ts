import { HttpEvent, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { ToastController } from '@ionic/angular';
import { Observable, tap } from 'rxjs';

type ToastTone = 'success' | 'danger' | 'medium';

let lastToastKey = '';
let lastToastAt = 0;

export const actionToastInterceptor: HttpInterceptorFn = (req, next): Observable<HttpEvent<unknown>> => {
  if (!isApiRequest(req.url)) return next(req);
  if (!isMutationMethod(req.method)) return next(req);
  if (req.headers.has('x-skip-action-toast')) return next(req);

  const toastController = inject(ToastController);

  return next(req).pipe(
    tap(async event => {
      if (!(event instanceof HttpResponse)) return;
      const body = event.body as Record<string, unknown> | null;
      if (body && body.ok === false) return;

      const toast = deriveToast(req.method, req.url, req.body);
      if (!toast) return;
      if (isDuplicateToast(toast.message)) return;

      const instance = await toastController.create({
        message: toast.message,
        color: toast.color,
        duration: 1700,
        position: 'top'
      });
      await instance.present();
    })
  );
};

function isMutationMethod(method: string): boolean {
  const normalized = String(method || '').trim().toUpperCase();
  return normalized === 'POST' || normalized === 'PUT' || normalized === 'PATCH' || normalized === 'DELETE';
}

function deriveToast(method: string, url: string, body: unknown): { message: string; color: ToastTone } | null {
  const op = normalizeOperation(body);
  const path = apiPath(url);
  const source = `${method}:${path}:${op}`;

  if (/(delete|remove|destroy|archive)/.test(source)) {
    return { message: 'Removed.', color: 'success' };
  }
  if (/(send|invite|dispatch)/.test(source)) {
    return { message: 'Sent.', color: 'success' };
  }
  if (/(import|upload)/.test(source)) {
    return { message: 'Saved.', color: 'success' };
  }
  if (/(save|set|update|upsert|create|rename|reorder|connect|disconnect|reset|checkin|checkout|pause|resume)/.test(source)) {
    return { message: 'Saved.', color: 'success' };
  }
  if (String(method || '').toUpperCase() === 'DELETE') {
    return { message: 'Removed.', color: 'success' };
  }
  return null;
}

function normalizeOperation(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const row = body as Record<string, unknown>;
  const op = String(row.op || row.action || row.scope || '').trim().toLowerCase();
  return op;
}

function isApiRequest(url: string): boolean {
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'https://localhost');
    return parsed.pathname.startsWith('/api/');
  } catch {
    return String(url || '').startsWith('/api/');
  }
}

function apiPath(url: string): string {
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'https://localhost');
    return parsed.pathname.toLowerCase();
  } catch {
    return String(url || '').toLowerCase();
  }
}

function isDuplicateToast(message: string): boolean {
  const key = String(message || '').trim().toLowerCase();
  if (!key) return true;
  const now = Date.now();
  if (lastToastKey === key && now - lastToastAt < 1200) return true;
  lastToastKey = key;
  lastToastAt = now;
  return false;
}
