import { CanDeactivateFn, Routes } from '@angular/router';
import { areaAccessGuard, registeredGuard, registrationGuard, roleGuard } from './auth/auth.guards';
import { customerProfileUnsavedGuard } from './pages/customer-profile/customer-profile.unsaved.guard';
import InvoiceDetailComponent from './pages/invoice-detail/invoice-detail.component';

const pendingPublicActionGuard: CanDeactivateFn<{ hasPendingAction(): boolean }> = component =>
  !component.hasPendingAction();

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'Pathflow | Automotive Shop Management Software',
    loadComponent: () =>
      import('./pages/corp-home/corp-home.component').then(m => m.default)
  },
  {
    path: 'visit/:tenant',
    title: 'Your service visit',
    loadComponent: () =>
      import('./pages/customer-portal/customer-portal.component').then(m => m.default)
  },
  {
    path: 'quote-response',
    canDeactivate: [pendingPublicActionGuard],
    loadComponent: () =>
      import('./pages/quote-response/quote-response.component').then(m => m.default)
  },
  {
    path: 'quote-accepted',
    canDeactivate: [pendingPublicActionGuard],
    data: { action: 'accept' },
    loadComponent: () =>
      import('./pages/quote-response/quote-response.component').then(m => m.default)
  },
  {
    path: 'quote-declined',
    canDeactivate: [pendingPublicActionGuard],
    data: { action: 'decline' },
    loadComponent: () =>
      import('./pages/quote-response/quote-response.component').then(m => m.default)
  },
  {
    path: 'invoice-payment',
    canDeactivate: [pendingPublicActionGuard],
    loadComponent: () =>
      import('./pages/invoice-payment/invoice-payment.component').then(m => m.default)
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
        canActivate: [areaAccessGuard],
        data: { area: 'dashboard' },
        loadComponent: () =>
          import('./pages/dashboard/dashboard.component').then(m => m.default)
      },
      {
        path: 'customers/new',
        canActivate: [areaAccessGuard],
        data: { area: 'customers' },
        canDeactivate: [customerProfileUnsavedGuard],
        loadComponent: () =>
          import('./pages/customer-profile/customer-profile.component').then(m => m.default)
      },
      {
        path: 'customers/duplicates',
        canActivate: [areaAccessGuard],
        data: { area: 'customers' },
        loadComponent: () =>
          import('./pages/customers-merge/customers-merge.component').then(m => m.default)
      },
      {
        path: 'customers/:id',
        canActivate: [areaAccessGuard],
        data: { area: 'customers' },
        canDeactivate: [customerProfileUnsavedGuard],
        loadComponent: () =>
          import('./pages/customer-profile/customer-profile.component').then(m => m.default)
      },
      {
        path: 'customers',
        canActivate: [areaAccessGuard],
        data: { area: 'customers' },
        loadComponent: () =>
          import('./pages/customers/customers.component').then(m => m.default)
      },
      {
        path: 'schedule',
        canActivate: [areaAccessGuard],
        data: { area: 'jobs' },
        loadComponent: () =>
          import('./pages/schedule/schedule.component').then(m => m.default)
      },
      {
        path: 'inventory',
        canActivate: [areaAccessGuard],
        data: { area: 'inventory' },
        loadComponent: () =>
          import('./pages/inventory/inventory.component').then(m => m.default)
      },
      {
        path: 'purchase-orders',
        canActivate: [areaAccessGuard],
        data: { area: 'purchase-orders' },
        loadComponent: () =>
          import('./pages/purchase-orders/purchase-orders.component').then(m => m.default)
      },
      {
        path: 'tasks',
        canActivate: [areaAccessGuard],
        data: { area: 'tasks' },
        loadComponent: () =>
          import('./pages/tasks/tasks.component').then(m => m.default)
      },
      {
        path: 'jobs/detail',
        canActivate: [areaAccessGuard],
        data: { area: 'jobs' },
        loadComponent: () =>
          import('./pages/job-detail/job-detail.component').then(m => m.default)
      },
      {
        path: 'invoices/new',
        canActivate: [areaAccessGuard],
        data: { area: ['quotes', 'invoices'] },
        loadComponent: () =>
          import('./pages/invoices-new/invoices-new.component').then(m => m.default)
      },
      {
        path: 'quotes/:id',
        canActivate: [areaAccessGuard],
        data: { area: 'quotes' },
        component: InvoiceDetailComponent
      },
      {
        path: 'invoices/:id/charge',
        canActivate: [areaAccessGuard],
        canDeactivate: [pendingPublicActionGuard],
        data: { area: 'invoices', staffCharge: true },
        loadComponent: () =>
          import('./pages/invoice-payment/invoice-payment.component').then(m => m.default)
      },
      {
        path: 'invoices/:id',
        canActivate: [areaAccessGuard],
        data: { area: 'invoices' },
        component: InvoiceDetailComponent
      },
      {
        path: 'invoices',
        redirectTo: 'quotes-invoices',
        pathMatch: 'full'
      },
      {
        path: 'quotes-invoices',
        canActivate: [areaAccessGuard],
        data: { area: ['quotes', 'invoices'] },
        loadComponent: () =>
          import('./pages/invoices/invoices.component').then(m => m.default)
      },
      {
        path: 'reports',
        canActivate: [areaAccessGuard],
        data: { area: 'reports' },
        loadComponent: () =>
          import('./pages/reports/reports.component').then(m => m.default)
      },
      {
        path: 'messages',
        canActivate: [areaAccessGuard],
        data: { area: 'customers' },
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
        data: { roles: ['admin'], area: 'settings-admin' },
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
  { path: '**', redirectTo: '' }
];
