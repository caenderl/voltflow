import type { Routes } from '@angular/router';
import { AdminPageComponent } from './admin/admin-page.component';
import { Dashboard } from './dashboard/dashboard';
import { HistoryContainerComponent } from './dashboard/history-container/history-container.component';
import { LiveContainerComponent } from './dashboard/live-container/live-container.component';

export const routes: Routes = [
  {
    // The dashboard shell (app-bar + tabs) hosts the four data views as
    // children; `view` reaches HistoryContainer via route data +
    // withComponentInputBinding().
    path: '',
    component: Dashboard,
    children: [
      { path: 'live', component: LiveContainerComponent },
      { path: 'day', component: HistoryContainerComponent, data: { view: 'day' } },
      { path: 'week', component: HistoryContainerComponent, data: { view: 'week' } },
      { path: 'month', component: HistoryContainerComponent, data: { view: 'month' } },
      { path: '', redirectTo: 'live', pathMatch: 'full' },
    ],
  },
  // Admin lives outside the shell so it gets the full width (no tab bar) and
  // its own mobile handling.
  { path: 'admin', component: AdminPageComponent },
  { path: '**', redirectTo: '' },
];
