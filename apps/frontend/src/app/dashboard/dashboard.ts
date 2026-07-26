import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { APP_VERSION } from '../../version';
import { type View } from '../core/date-utils';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard {
  private readonly router = inject(Router);

  readonly appVersion = APP_VERSION;

  // The nav tabs map onto the data-view routes. The first four are the View
  // union, so a typo there fails to compile; 'billing' is its own route with no
  // period arithmetic behind it and therefore not part of that union.
  readonly views: { path: View | 'billing'; label: string }[] = [
    { path: 'live', label: 'Live' },
    { path: 'day', label: 'Tag' },
    { path: 'week', label: 'Woche' },
    { path: 'month', label: 'Monat' },
    { path: 'billing', label: 'Abrechnung' },
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
}
