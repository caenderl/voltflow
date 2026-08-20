import { Component, computed, input } from '@angular/core';
import type { StatisticsResponse } from '@org/shared-types';
import { formatDay } from '../../core/stat-format';
import { StatisticsStorageSizingComponent } from '../statistics-storage-sizing/statistics-storage-sizing.component';
import { StatisticsHighlightsComponent } from '../statistics-highlights/statistics-highlights.component';

/**
 * Presentational shell of the statistics view: the period the figures rest on,
 * the record cards and the storage sizing. Holds no state — the container owns
 * the loading.
 */
@Component({
  selector: 'app-statistics-view',
  standalone: true,
  imports: [StatisticsHighlightsComponent, StatisticsStorageSizingComponent],
  templateUrl: './statistics-view.component.html',
  styleUrl: './statistics-view.component.scss',
})
export class StatisticsViewComponent {
  readonly statistics = input<StatisticsResponse | null>(null);
  readonly loading = input<boolean>(false);
  readonly error = input<string | null>(null);

  /**
   * What the numbers stand on. Two spans, because they genuinely differ: the
   * daily figures need days without holes, the peaks come from the minute
   * aggregate and reach back only as far as it is kept.
   */
  readonly period = computed(() => {
    const s = this.statistics();
    if (!s || !s.days) return 'Noch keine vollständigen Tage gemessen.';
    const days = `${s.days} ${s.days === 1 ? 'Tag' : 'Tage'}`;
    return `${days} mit vollständigen Daten · ${formatDay(s.firstDay)} bis ${formatDay(
      s.lastDay,
    )}`;
  });

  /** Nothing measured yet — then the note has no figures to qualify. */
  readonly showPeakNote = computed(() => {
    const s = this.statistics();
    return !!s && (s.days > 0 || !!s.pv.peak || !!s.consumption.peak);
  });

  readonly peakNote = computed(() => {
    const s = this.statistics();
    if (!s) return '';
    return `Spitzenwerte aus 1-Minuten-Mitteln der letzten ${s.peakWindowDays} Tage; Tages- und Jahreswerte aus allen vollständigen Tagen.`;
  });
}
