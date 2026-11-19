import { bootstrapApplication } from '@angular/platform-browser';
import AppComponent from './app/app.component';
import { appConfig } from './app/app.config';

if (typeof window !== 'undefined') {
  try {
    performance.mark('pathflow.app.bootstrap.start');
  } catch {
    // Performance markers are diagnostic only.
  }
}

bootstrapApplication(AppComponent, appConfig);
