import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { StatisticsResponse } from '@org/shared-types';
import { StatisticsApiService } from '../../core/statistics-api.service';
import { StatisticsViewComponent } from '../statistics-view/statistics-view.component';

/**
 * State for the statistics view. One request, no period to navigate — the page
 * is about everything ever measured — so it loads on its own instead of going
 * through DashboardDataService, same as the billing container.
 */
@Component({
  selector: 'app-statistics-container',
  standalone: true,
  imports: [StatisticsViewComponent],
  template: `
    <app-statistics-view
      [statistics]="statistics()"
      [loading]="loading()"
      [error]="error()"
    />
  `,
})
export class StatisticsContainerComponent {
  private readonly api = inject(StatisticsApiService);

  readonly statistics = signal<StatisticsResponse | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);

  constructor() {
    this.api
      .statistics()
      .pipe(takeUntilDestroyed())
      .subscribe({
        next: (s) => {
          this.statistics.set(s);
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Statistik konnte nicht geladen werden.');
          this.loading.set(false);
        },
      });
  }
}
