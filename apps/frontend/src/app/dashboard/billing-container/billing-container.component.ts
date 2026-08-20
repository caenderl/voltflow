import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { BillingStatement } from '@org/shared-types';
import { BillingApiService } from '../../core/billing-api.service';
import { clockTick } from '../../core/clock';
import { DashboardDataService } from '../dashboard-data.service';
import { BillingViewComponent } from '../billing-view/billing-view.component';

/**
 * State for the billing view: which year is shown, and its statement.
 *
 * Loads on its own rather than through DashboardDataService — the statement is
 * self-contained (one request per year) and nothing else in the app needs it, so
 * putting it in the shared store would only widen that service's surface.
 */
@Component({
  selector: 'app-billing-container',
  standalone: true,
  imports: [BillingViewComponent],
  template: `
    <app-billing-view
      [statement]="statement()"
      [year]="year()"
      [canPrev]="canPrev()"
      [canNext]="canNext()"
      [loading]="loading()"
      [error]="error()"
      (prevClicked)="shift(-1)"
      (nextClicked)="shift(1)"
    />
  `,
})
export class BillingContainerComponent {
  private readonly api = inject(BillingApiService);
  private readonly data = inject(DashboardDataService);
  // Explicit, because `load()` also runs from the year navigation, outside the
  // injection context where takeUntilDestroyed() could find one itself.
  private readonly destroyRef = inject(DestroyRef);

  readonly year = signal(new Date().getFullYear());
  readonly statement = signal<BillingStatement | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  /** Don't page back past the first reading the database holds. */
  readonly canPrev = computed(() => {
    const first = this.data.dataRange()?.first;
    return first ? new Date(first).getFullYear() < this.year() : false;
  });

  /** …nor forward into a year that has not started. */
  readonly canNext = computed(() => {
    clockTick(); // re-evaluate across a New Year's Eve boundary in a long-lived tab
    return this.year() < new Date().getFullYear();
  });

  // Guards against a response for a year the user has since navigated away
  // from landing after a newer request and overwriting it (same hazard
  // DashboardDataService.loadPeriod's periodSeq guards against).
  private loadSeq = 0;

  constructor() {
    this.load();
  }

  shift(dir: -1 | 1): void {
    if (dir === -1 && !this.canPrev()) return;
    if (dir === 1 && !this.canNext()) return;
    this.year.update((y) => y + dir);
    this.load();
  }

  private load(): void {
    const seq = ++this.loadSeq;
    const current = () => seq === this.loadSeq;
    this.loading.set(true);
    this.error.set(null);
    // Clear up front so a slow response never leaves the previous year's
    // statement on screen under the new year's header.
    this.statement.set(null);
    this.api
      .statement(this.year())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (s) => {
          if (!current()) return;
          this.statement.set(s);
          this.loading.set(false);
        },
        error: () => {
          if (!current()) return;
          this.error.set('Abrechnung konnte nicht geladen werden.');
          this.loading.set(false);
        },
      });
  }
}
