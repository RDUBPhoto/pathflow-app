import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';

import AppComponent from './app/app.component';
import { routes } from './app/app.routes';
import { tenantHeaderInterceptor } from './app/interceptors/tenant-header.interceptor';

const CHUNK_RELOAD_GUARD_KEY = 'pathflow.chunk-reload.v1';

if (typeof window !== 'undefined') {
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

bootstrapApplication(AppComponent, {
  providers: [
    provideIonicAngular(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([tenantHeaderInterceptor]))
  ]
});
