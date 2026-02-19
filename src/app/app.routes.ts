import { Routes } from '@angular/router';
import { authGuard, roleGuard } from './auth/auth.guards';
import { customerProfileUnsavedGuard } from './pages/customer-profile/customer-profile.unsaved.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./pages/login/login.component').then(m => m.default)
  },
  {
    path: 'sms-opt-in',
    loadComponent: () =>
      import('./pages/sms-opt-in/sms-opt-in.component').then(m => m.default)
  },
  {
    canActivate: [authGuard],
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
