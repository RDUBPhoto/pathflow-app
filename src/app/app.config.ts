import { ApplicationConfig, inject, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, Router, withInMemoryScrolling, withNavigationErrorHandler } from '@angular/router';
import { routes } from './app.routes';
import { provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { tenantHeaderInterceptor } from './interceptors/tenant-header.interceptor';
import { authExpiredInterceptor } from './interceptors/auth-expired.interceptor';
import { recoverNavigationAssets } from './asset-recovery';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection(),
    provideRouter(routes, withInMemoryScrolling({ anchorScrolling: 'enabled' }),
      withNavigationErrorHandler(event => recoverNavigationAssets(event, inject(Router)))),
    provideHttpClient(withXhr(), withInterceptors([
      tenantHeaderInterceptor,
      authExpiredInterceptor
    ]))
  ]
};
