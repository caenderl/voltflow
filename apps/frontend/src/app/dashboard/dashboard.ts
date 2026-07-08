import { Component, OnInit, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { APP_VERSION } from '../../version';
import { DashboardDataService } from './dashboard-data.service';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit {
  private readonly data = inject(DashboardDataService);
  private readonly router = inject(Router);

  readonly appVersion = APP_VERSION;

  readonly views: { path: string; label: string }[] = [
    { path: 'live', label: 'Live' },
    { path: 'day', label: 'Tag' },
    { path: 'week', label: 'Woche' },
    { path: 'month', label: 'Monat' },
  ];

  // The live view uses a full-height flex layout; the history views don't.
  // Tracks the active route so the shell can toggle that layout class.
  readonly isLive = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => this.router.url.startsWith('/live')),
    ),
    { initialValue: this.router.url === '/' || this.router.url.startsWith('/live') },
  );

  ngOnInit(): void {
    this.data.start();
  }
}
