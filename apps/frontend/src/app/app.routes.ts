import type { Routes } from '@angular/router';
import { Dashboard } from './dashboard/dashboard';
import { HistoryContainerComponent } from './dashboard/history-container/history-container.component';
import { LiveContainerComponent } from './dashboard/live-container/live-container.component';

export const routes: Routes = [
  {
    // The dashboard shell (app-bar + tabs) hosts the data views as children;
    // `view` reaches HistoryContainer via route data +
    // withComponentInputBinding().
    //
    // Live and the history views are what the app is opened for, so they ship
    // in the main bundle. Billing, statistics and admin are visited now and
    // then and are split off, which keeps them out of the JS parsed before the
    // first render. (The service worker still prefetches every chunk in the
    // background once the app is stable - this shortens startup, it does not
    // save the download.)
    path: '',
    component: Dashboard,
    children: [
      { path: 'live', component: LiveContainerComponent },
      { path: 'day', component: HistoryContainerComponent, data: { view: 'day' } },
      { path: 'week', component: HistoryContainerComponent, data: { view: 'week' } },
      { path: 'month', component: HistoryContainerComponent, data: { view: 'month' } },
      {
        path: 'billing',
        loadComponent: () =>
          import('./dashboard/billing-container/billing-container.component').then(
            (m) => m.BillingContainerComponent,
          ),
      },
      {
        path: 'statistics',
        loadComponent: () =>
          import('./dashboard/statistics-container/statistics-container.component').then(
            (m) => m.StatisticsContainerComponent,
          ),
      },
      { path: '', redirectTo: 'live', pathMatch: 'full' },
    ],
  },
  // Admin lives outside the shell so it gets the full width (no tab bar) and
  // its own mobile handling.
  {
    path: 'admin',
    loadComponent: () =>
      import('./admin/admin-page.component').then((m) => m.AdminPageComponent),
  },
  { path: '**', redirectTo: '' },
];
