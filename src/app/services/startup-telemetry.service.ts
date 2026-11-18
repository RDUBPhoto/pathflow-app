import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

type TelemetryProperty = string | number | boolean;

interface StartupTelemetryEvent {
  event: string;
  timestamp: string;
  pagePath: string;
  properties: Record<string, TelemetryProperty>;
  measurements: Record<string, number>;
}

@Injectable({ providedIn: 'root' })
export class StartupTelemetryService {
  now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  mark(name: string): void {
    if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
    try {
      performance.mark(this.performanceName(name));
    } catch {
      // Performance markers must never interfere with application startup.
    }
  }

  trackDuration(
    event: string,
    startedAt: number,
    properties: Record<string, TelemetryProperty> = {},
    measurements: Record<string, number> = {}
  ): number {
    const durationMs = Math.max(0, this.now() - startedAt);
    this.mark(`${event}.complete`);
    this.send({
      event,
      timestamp: new Date().toISOString(),
      pagePath: typeof window !== 'undefined' ? window.location.pathname : '',
      properties,
      measurements: {
        ...measurements,
        durationMs: Math.round(durationMs * 100) / 100
      }
    });
    return durationMs;
  }

  private send(payload: StartupTelemetryEvent): void {
    if (!environment.telemetry?.enabled || typeof window === 'undefined') return;
    if (window.location.port === '9876' || window.location.pathname.startsWith('/_karma_webpack_')) return;
    const endpoint = String(environment.telemetry.endpoint || '/api/telemetry').trim() || '/api/telemetry';
    const body = JSON.stringify(payload);

    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const queued = navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
        if (queued) return;
      }
    } catch {
      // Fall back to keepalive fetch below.
    }

    void fetch(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true
    }).catch(() => undefined);
  }

  private performanceName(name: string): string {
    return `pathflow.${String(name || 'startup').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;
  }
}
