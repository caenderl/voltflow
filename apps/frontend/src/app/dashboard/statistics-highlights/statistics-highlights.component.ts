import { Component, computed, input } from '@angular/core';
import type {
  ConsumptionStatistics,
  PvStatistics,
  StandbyStatistics,
} from '@org/shared-types';
import {
  formatDay,
  formatKwhUnit,
  formatMoment,
  formatPercent,
  formatWatts,
} from '../../core/stat-format';
import { StatCardComponent } from '../../ui/stat-card/stat-card.component';
import { StatRowsComponent, type StatRow } from '../../ui/stat-rows/stat-rows.component';

/**
 * The three figures the page leads with: what the roof produced at its best,
 * what the house drew at its worst, and what it draws when nothing runs.
 *
 * The two records put the *peak power* in the headline and the energy records
 * in the rows below — the peak is what sizes an inverter or a fuse, the kWh
 * are what size a battery.
 */
@Component({
  selector: 'app-statistics-highlights',
  standalone: true,
  imports: [StatCardComponent, StatRowsComponent],
  templateUrl: './statistics-highlights.component.html',
  styleUrl: './statistics-highlights.component.scss',
})
export class StatisticsHighlightsComponent {
  readonly pv = input.required<PvStatistics>();
  readonly consumption = input.required<ConsumptionStatistics>();
  readonly standby = input.required<StandbyStatistics>();

  readonly pvPeak = computed(() => formatWatts(this.pv().peak?.powerW));
  readonly pvPeakAt = computed(() => peakCaption(this.pv().peak?.time));
  readonly pvRows = computed<StatRow[]>(() => {
    const p = this.pv();
    return [
      {
        label: 'Bester Tag',
        value: formatKwhUnit(p.bestDay?.kwh),
        hint: p.bestDay ? formatDay(p.bestDay.day, true) : undefined,
      },
      { label: 'Ø pro Tag', value: formatKwhUnit(p.avgDayKwh) },
    ];
  });

  readonly loadPeak = computed(() => formatWatts(this.consumption().peak?.powerW));
  readonly loadPeakAt = computed(() => peakCaption(this.consumption().peak?.time));
  readonly loadRows = computed<StatRow[]>(() => {
    const c = this.consumption();
    return [
      {
        label: 'Stärkster Tag',
        value: formatKwhUnit(c.maxDay?.kwh),
        hint: c.maxDay ? formatDay(c.maxDay.day, true) : undefined,
      },
      { label: 'Ø pro Tag', value: formatKwhUnit(c.avgDayKwh) },
    ];
  });

  readonly standbyPower = computed(() => formatWatts(this.standby().avgW));
  readonly standbyCaption = computed(() => {
    const s = this.standby();
    if (!s.nights) return 'noch keine vollständige Nacht gemessen';
    const nights = `${s.nights} ${s.nights === 1 ? 'Nacht' : 'Nächte'}`;
    return `ruhigste Stunden zwischen 0 und 5 Uhr, über ${nights}`;
  });
  readonly standbyRows = computed<StatRow[]>(() => {
    const s = this.standby();
    return [
      { label: 'Pro Tag', value: formatKwhUnit(s.perDayKwh) },
      { label: 'Im Jahr', value: formatKwhUnit(s.perYearKwh, 0) },
      { label: 'Anteil am Verbrauch', value: formatPercent(s.shareOfConsumption) },
    ];
  });
}

/** "Spitze am 4. Juli 2026, 11:35" — nothing to date without a peak. */
function peakCaption(time: string | null | undefined): string {
  return time ? `Spitze am ${formatMoment(time)}` : 'noch keine Daten';
}
