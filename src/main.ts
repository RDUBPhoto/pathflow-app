import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';

import AppComponent from './app/app.component';
import { routes } from './app/app.routes';
import { tenantHeaderInterceptor } from './app/interceptors/tenant-header.interceptor';

bootstrapApplication(AppComponent, {
  providers: [
    provideIonicAngular(),
    provideRouter(routes),
    provideHttpClient(withInterceptors([tenantHeaderInterceptor]))
  ]
});
