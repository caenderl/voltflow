import { Component, computed, input } from '@angular/core';
import type { StorageSizing } from '@org/shared-types';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsCoreOption } from 'echarts/core';
import { CHART_COLORS, categorySeriesChart } from '../../core/chart-utils';
import { formatKwh, formatKwhUnit, formatPercent } from '../../core/stat-format';
import { StatCardComponent } from '../../ui/stat-card/stat-card.component';

/**
 * Storage sizing: what a store would have to hold, and what it would buy.
 * A simulation of a *hypothetical* store, not a reading from an installed one.
 *
 * Three tiles for the sizes that matter — what is there today, the size where
 * every further kWh stops paying, and the one that would have removed the last
 * kWh of grid import — over a curve that shows the whole trade-off.
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
  /** Days the simulation ran on, for the caption under the tiles. */
  readonly days = input.required<number>();

  readonly hasData = computed(() => this.sizing().curve.length > 0);

  readonly baseAutarky = computed(() => formatPercent(this.sizing().baseAutarky));

  readonly kneeValue = computed(() => formatKwh(this.sizing().kneeKwh, 0));
  readonly kneeCaption = computed(() => {
    const b = this.sizing();
    if (!b.kneeKwh) return 'ein Speicher lohnt sich hier kaum';
    return `bringt ${formatPercent(b.kneeAutarky)} Autarkie`;
  });

  readonly fullValue = computed(() => formatKwh(this.sizing().fullAutarkyKwh, 1));
  readonly fullCaption = computed(() =>
    this.sizing().fullAutarkyKwh === null
      ? 'im gemessenen Zeitraum nicht erreichbar'
      : 'deckt jede gemessene Stunde ohne Netz',
  );

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
   * Why 100 % may be out of reach, in one sentence: with less sun than load
   * over the period, no size can bridge it — that is a PV question, not a
   * storage one.
   */
  readonly verdict = computed(() => {
    const b = this.sizing();
    if (b.fullAutarkyKwh !== null) {
      return `Über den gemessenen Zeitraum hätte ein Speicher mit ${formatKwh(
        b.fullAutarkyKwh,
        1,
      )} kWh jede Kilowattstunde selbst gedeckt — 100 % Autarkie.`;
    }
    if (b.productionKwh < b.consumptionKwh) {
      return `Im gemessenen Zeitraum lag die Erzeugung (${formatKwh(
        b.productionKwh,
        0,
      )} kWh) unter dem Verbrauch (${formatKwh(
        b.consumptionKwh,
        0,
      )} kWh). Diese Lücke kann kein Speicher füllen — die Energie fehlt.`;
    }
    return 'Die Erzeugung reicht in Summe, kommt aber zu selten zur richtigen Zeit: 100 % Autarkie würde einen Speicher jenseits jeder sinnvollen Größe brauchen.';
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
      { legend: true, unit: '%', xAxisName: 'Speichergröße (kWh)' },
    );
  });

  readonly basis = computed(() => {
    const b = this.sizing();
    const days = this.days();
    return `Simuliert über ${days} ${days === 1 ? 'Tag' : 'Tage'} mit vollständigen Daten · ${formatPercent(
      b.efficiency,
    )} Wirkungsgrad · Laden nur aus Überschuss`;
  });
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
