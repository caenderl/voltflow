import { Component, computed, input } from '@angular/core';
import type { StorageSizing } from '@org/shared-types';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsCoreOption } from 'echarts/core';
import { CHART_COLORS, categorySeriesChart } from '../../core/chart-utils';
import { formatDay, formatKwh, formatKwhUnit, formatPercent } from '../../core/stat-format';
import { StatCardComponent } from '../../ui/stat-card/stat-card.component';

/**
 * Storage sizing: what a store would have to hold, and what it would buy.
 * A simulation of a *hypothetical* store, not a reading from an installed one.
 *
 * Three tiles for the sizes that matter — what is there today, the size where
 * every further kWh stops paying, and the one that would have covered the
 * whole house (the car aside) — over a curve that shows the whole trade-off.
 */
@Component({
  selector: 'app-statistics-storage-sizing',
  standalone: true,
  imports: [NgxEchartsDirective, StatCardComponent],
  templateUrl: './statistics-storage-sizing.component.html',
  styleUrl: './statistics-storage-sizing.component.scss',
})
export class StatisticsStorageSizingComponent {
  readonly sizing = input.required<StorageSizing>();

  readonly hasData = computed(() => this.sizing().curve.length > 0);

  readonly baseAutarky = computed(() => formatPercent(this.sizing().baseAutarky));

  readonly kneeValue = computed(() => formatKwh(this.sizing().kneeKwh, 0));
  readonly kneeCaption = computed(() => {
    const b = this.sizing();
    if (!b.kneeKwh) return 'ein Speicher lohnt sich hier kaum';
    return `bringt ${formatPercent(b.kneeAutarky)} Autarkie`;
  });

  readonly fullValue = computed(() => formatKwh(this.sizing().fullCoverageKwh, 1));
  readonly fullCaption = computed(() => {
    const b = this.sizing();
    if (b.fullCoverageKwh === null) return 'im gemessenen Zeitraum nicht erreichbar';
    const autarky = `bringt ${formatPercent(b.fullCoverageAutarky)} Autarkie`;
    return carImportLeft(b) ? `${autarky}, der Rest ist das Auto` : autarky;
  });

  /** The figures behind the curve, as a compact line under the chart. */
  readonly facts = computed(() => {
    const b = this.sizing();
    return [
      `Typische Nacht ${formatKwhUnit(b.medianNightKwh)}`,
      `Längste Nacht ${formatKwhUnit(b.maxNightKwh)}`,
      `Erzeugung ${formatKwhUnit(b.productionKwh, 0)} / Verbrauch ${formatKwhUnit(
        b.consumptionKwh,
        0,
      )}`,
    ];
  });

  /**
   * The answer in one sentence: the size that would have covered the house,
   * or, where none does, the point the curve flattens out.
   */
  readonly verdict = computed(() => {
    const b = this.sizing();
    if (b.fullCoverageKwh !== null) {
      const kwh = formatKwh(b.fullCoverageKwh, 1);
      const house = `Mit ${kwh} kWh wäre das Haus im gemessenen Zeitraum ohne Netzbezug ausgekommen`;
      return carImportLeft(b)
        ? `${house}, nur das Auto hätte noch Netzstrom geladen.`
        : `${house}.`;
    }
    if (!b.kneeKwh) {
      return (
        'Ein Speicher brächte hier kaum etwas: schon die erste Kilowattstunde ' +
        'hebt die Autarkie um weniger als einen Prozentpunkt.'
      );
    }
    return (
      `Bis ${formatKwh(b.kneeKwh, 0)} kWh bringt jede weitere Kilowattstunde ` +
      'mindestens einen Prozentpunkt Autarkie, danach flacht die Kurve ab. ' +
      'Ganz ohne Netz wäre das Haus mit keiner Größe ausgekommen.'
    );
  });

  readonly chart = computed<EChartsCoreOption>(() => {
    const curve = this.sizing().curve;
    return categorySeriesChart(
      curve.map((p) => String(p.capacityKwh)),
      [
        {
          name: 'Autarkie',
          color: CHART_COLORS.export,
          type: 'line',
          data: curve.map((p) => round1(p.autarky * 100)),
        },
        {
          name: 'Eigenverbrauch',
          color: CHART_COLORS.production,
          type: 'line',
          data: curve.map((p) => round1(p.selfConsumption * 100)),
        },
      ],
      { legend: true, unit: '%', xAxisName: 'Nutzbare Kapazität (kWh)' },
    );
  });

  readonly basis = computed(() => {
    const b = this.sizing();
    const { days, skippedDays, firstDay: first, lastDay: last } = b;
    const parts = [
      `Simuliert über ${days} ${days === 1 ? 'Tag' : 'Tage'} (${formatDay(
        first,
        true,
      )} – ${formatDay(last, true)})`,
      `${formatPercent(b.efficiency)} Wirkungsgrad`,
      'Laden nur aus Überschuss',
      'das Auto lädt nicht aus dem Speicher',
    ];
    if (skippedDays) {
      parts.push(
        `${skippedDays} ${skippedDays === 1 ? 'Tag' : 'Tage'} ohne Wallbox-Daten ausgelassen`,
      );
    }
    const basis = parts.join(' · ');
    return first && last && !coversWinter(first, last)
      ? `${basis}. Noch ohne Wintermonate: übers Jahr bringt ein Speicher ` +
          'weniger, als die Kurve zeigt.'
      : basis;
  });
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Whether the car still imported at the size that covers the house — then
 * that size stops short of 100 % autarky by exactly the car's import.
 */
function carImportLeft(b: StorageSizing): boolean {
  return b.fullCoverageAutarky !== null && b.fullCoverageAutarky < 0.995;
}

/** Whether any month from November to February lies between the two days. */
function coversWinter(firstDay: string, lastDay: string): boolean {
  const d = new Date(`${firstDay.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${lastDay}T00:00:00Z`);
  for (; d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const month = d.getUTCMonth() + 1;
    if (month >= 11 || month <= 2) return true;
  }
  return false;
}
