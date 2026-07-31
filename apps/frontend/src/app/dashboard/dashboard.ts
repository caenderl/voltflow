import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';
import { APP_VERSION } from '../../version';
import { type View } from '../core/date-utils';

// Tab icons, drawn as one `d` each (the template renders a single <path> with
// fill-rule="evenodd", so the inner shapes cut out as holes).
/** A receipt with a torn bottom edge and two lines of print. */
const RECEIPT_ICON =
  'M6 2h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5-2 1.5V2z M8.5 6h7v2h-7z M8.5 10h7v2h-7z';
/** Three bars of a chart, rising and falling. */
const BARS_ICON = 'M4 19h3.5v-7H4z M10.25 19h3.5V5h-3.5z M16.5 19H20V9h-3.5z';

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
  // union, so a typo there fails to compile; billing and statistics are their
  // own routes with no period arithmetic behind them and therefore not part of
  // that union.
  //
  // Those two carry an icon instead of a label: their names are the longest of
  // the six and would push the pill past the width a phone has, while the four
  // period tabs are switched constantly and stay readable words. `label` is
  // kept either way — an icon tab still needs its name for screen readers and
  // the tooltip.
  readonly views: { path: View | 'billing' | 'statistics'; label: string; icon?: string }[] =
    [
      { path: 'live', label: 'Live' },
      { path: 'day', label: 'Tag' },
      { path: 'week', label: 'Woche' },
      { path: 'month', label: 'Monat' },
      { path: 'billing', label: 'Abrechnung', icon: RECEIPT_ICON },
      { path: 'statistics', label: 'Statistik', icon: BARS_ICON },
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
