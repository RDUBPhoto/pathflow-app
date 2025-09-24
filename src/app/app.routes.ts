import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/dashboard/dashboard.component').then(m => m.default) },
  { path: 'customers', loadComponent: () => import('./pages/customers/customers.component').then(m => m.default) },
  { path: '**', redirectTo: '' }
];