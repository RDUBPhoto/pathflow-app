import { bootstrapApplication } from '@angular/platform-browser';
import AppComponent from './app/app.component';
import { appConfig } from './app/app.config';

const CHUNK_RELOAD_GUARD_KEY = 'pathflow.chunk-reload.v1';

if (typeof window !== 'undefined') {
  try {
    performance.mark('pathflow.app.bootstrap.start');
  } catch {
    // Performance markers are diagnostic only.
  }
  window.addEventListener('error', event => {
    const message = String((event as ErrorEvent)?.message || '').toLowerCase();
    const isChunkError =
      message.includes('failed to fetch dynamically imported module') ||
      message.includes('importing a module script failed');
    if (!isChunkError) return;

    const alreadyReloaded = sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY) === '1';
    if (alreadyReloaded) return;
    sessionStorage.setItem(CHUNK_RELOAD_GUARD_KEY, '1');
    window.location.reload();
  });
}

bootstrapApplication(AppComponent, appConfig);
