import { Routes } from '@angular/router';
import { registeredGuard, registrationGuard, roleGuard } from './auth/auth.guards';
import { customerProfileUnsavedGuard } from './pages/customer-profile/customer-profile.unsaved.guard';

export const routes: Routes = [
  {
    path: 'quote-response',
    loadComponent: () =>
      import('./pages/quote-response/quote-response.component').then(m => m.default)
  },
  {
    path: 'quote-accepted',
    data: { action: 'accept' },
    loadComponent: () =>
      import('./pages/quote-response/quote-response.component').then(m => m.default)
  },
  {
    path: 'quote-declined',
    data: { action: 'decline' },
    loadComponent: () =>
      import('./pages/quote-response/quote-response.component').then(m => m.default)
  },
  {
    path: 'sms-opt-in-other',
    loadComponent: () =>
      import('./pages/sms-opt-in-other/sms-opt-in-other.component').then(m => m.default)
  },
  {
    path: 'privacy-policy',
    loadComponent: () =>
      import('./pages/privacy-policy/privacy-policy.component').then(m => m.default)
  },
  {
    path: 'terms-and-conditions',
    loadComponent: () =>
      import('./pages/terms-and-conditions/terms-and-conditions.component').then(m => m.default)
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./pages/login/login.component').then(m => m.default)
  },
  {
    path: 'signup',
    loadComponent: () =>
      import('./pages/signup/signup.component').then(m => m.default)
  },
  {
    path: 'register',
    canActivate: [registrationGuard],
    loadComponent: () =>
      import('./pages/register/register.component').then(m => m.default)
  },
  {
    path: 'billing',
    canActivate: [registeredGuard],
    loadComponent: () =>
      import('./pages/register/register.component').then(m => m.default)
  },
  {
    path: 'sms-opt-in',
    loadComponent: () =>
      import('./pages/sms-opt-in/sms-opt-in.component').then(m => m.default)
  },
  {
    canActivate: [registeredGuard],
    path: '',
    loadComponent: () =>
      import('./layout/internal-shell/internal-shell.component').then(m => m.InternalShellComponent),
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      {
        path: 'dashboard',
        loadComponent: () =>
          import('./pages/dashboard/dashboard.component').then(m => m.default)
      },
      {
        path: 'customers/new',
        canDeactivate: [customerProfileUnsavedGuard],
        loadComponent: () =>
          import('./pages/customer-profile/customer-profile.component').then(m => m.default)
      },
      {
        path: 'customers/duplicates',
        loadComponent: () =>
          import('./pages/customers-merge/customers-merge.component').then(m => m.default)
      },
      {
        path: 'customers/:id',
        canDeactivate: [customerProfileUnsavedGuard],
        loadComponent: () =>
          import('./pages/customer-profile/customer-profile.component').then(m => m.default)
      },
      {
        path: 'customers',
        loadComponent: () =>
          import('./pages/customers/customers.component').then(m => m.default)
      },
      {
        path: 'schedule',
        loadComponent: () =>
          import('./pages/schedule/schedule.component').then(m => m.default)
      },
      {
        path: 'inventory',
        loadComponent: () =>
          import('./pages/inventory/inventory.component').then(m => m.default)
      },
      {
        path: 'invoices/new',
        loadComponent: () =>
          import('./pages/invoices-new/invoices-new.component').then(m => m.default)
      },
      {
        path: 'invoices/:id',
        loadComponent: () =>
          import('./pages/invoice-detail/invoice-detail.component').then(m => m.default)
      },
      {
        path: 'invoices',
        loadComponent: () =>
          import('./pages/invoices/invoices.component').then(m => m.default)
      },
      {
        path: 'reports',
        loadComponent: () =>
          import('./pages/reports/reports.component').then(m => m.default)
      },
      {
        path: 'messages',
        loadComponent: () =>
          import('./pages/messages/messages.component').then(m => m.default)
      },
      {
        path: 'user-settings',
        loadComponent: () =>
          import('./pages/user-settings/user-settings.component').then(m => m.default)
      },
      {
        path: 'admin-settings',
        canActivate: [roleGuard],
        data: { roles: ['admin'] },
        loadComponent: () =>
          import('./pages/admin-settings/admin-settings.component').then(m => m.default)
      },
      {
        path: 'forbidden',
        loadComponent: () =>
          import('./pages/forbidden/forbidden.component').then(m => m.default)
      }
    ]
  },
  { path: '**', redirectTo: 'dashboard' }
];
