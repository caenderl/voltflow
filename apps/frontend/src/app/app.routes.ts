import type { Routes } from '@angular/router';
import { AdminPageComponent } from './admin/admin-page.component';
import { BillingContainerComponent } from './dashboard/billing-container/billing-container.component';
import { Dashboard } from './dashboard/dashboard';
import { HistoryContainerComponent } from './dashboard/history-container/history-container.component';
import { LiveContainerComponent } from './dashboard/live-container/live-container.component';
import { StatisticsContainerComponent } from './dashboard/statistics-container/statistics-container.component';

export const routes: Routes = [
  {
    // The dashboard shell (app-bar + tabs) hosts the data views as children;
    // `view` reaches HistoryContainer via route data +
    // withComponentInputBinding().
    path: '',
    component: Dashboard,
    children: [
      { path: 'live', component: LiveContainerComponent },
      { path: 'day', component: HistoryContainerComponent, data: { view: 'day' } },
      { path: 'week', component: HistoryContainerComponent, data: { view: 'week' } },
      { path: 'month', component: HistoryContainerComponent, data: { view: 'month' } },
      { path: 'billing', component: BillingContainerComponent },
      { path: 'statistics', component: StatisticsContainerComponent },
      { path: '', redirectTo: 'live', pathMatch: 'full' },
    ],
  },
  // Admin lives outside the shell so it gets the full width (no tab bar) and
  // its own mobile handling.
  { path: 'admin', component: AdminPageComponent },
  { path: '**', redirectTo: '' },
];
