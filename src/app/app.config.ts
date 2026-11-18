import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { tenantHeaderInterceptor } from './interceptors/tenant-header.interceptor';
import { authExpiredInterceptor } from './interceptors/auth-expired.interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection(),
    provideRouter(routes, withInMemoryScrolling({ anchorScrolling: 'enabled' })),
    provideHttpClient(withXhr(), withInterceptors([
      tenantHeaderInterceptor,
      authExpiredInterceptor
    ]))
  ]
};
