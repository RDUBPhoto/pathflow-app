import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { tenantHeaderInterceptor } from './interceptors/tenant-header.interceptor';
import { authExpiredInterceptor } from './interceptors/auth-expired.interceptor';
import { actionToastInterceptor } from './interceptors/action-toast.interceptor';


export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes, withInMemoryScrolling({ anchorScrolling: 'enabled' })),
    provideIonicAngular(),
    provideHttpClient(withInterceptors([tenantHeaderInterceptor, authExpiredInterceptor, actionToastInterceptor]))
  ]
};
