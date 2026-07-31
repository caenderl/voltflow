import { Component, computed, input } from '@angular/core';
import type { BatteryStatistics } from '@org/shared-types';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsCoreOption } from 'echarts/core';
import { CHART_COLORS, categorySeriesChart } from '../../core/chart-utils';
import { formatKwh, formatKwhUnit, formatPercent } from '../../core/stat-format';
import { StatCardComponent } from '../../ui/stat-card/stat-card.component';

/**
 * Battery sizing: what a storage would have to hold, and what it would buy.
 *
 * Three tiles for the sizes that matter — what is there today, the size where
 * every further kWh stops paying, and the one that would have removed the last
 * kWh of grid import — over a curve that shows the whole trade-off.
 */
@Component({
  selector: 'app-statistics-battery',
  standalone: true,
  imports: [NgxEchartsDirective, StatCardComponent],
  templateUrl: './statistics-battery.component.html',
  styleUrl: './statistics-battery.component.scss',
})
export class StatisticsBatteryComponent {
  readonly battery = input.required<BatteryStatistics>();
  /** Days the simulation ran on, for the caption under the tiles. */
  readonly days = input.required<number>();

  readonly hasData = computed(() => this.battery().curve.length > 0);

  readonly baseAutarky = computed(() => formatPercent(this.battery().baseAutarky));

  readonly kneeValue = computed(() => formatKwh(this.battery().kneeKwh, 0));
  readonly kneeCaption = computed(() => {
    const b = this.battery();
    if (!b.kneeKwh) return 'ein Speicher lohnt sich hier kaum';
    return `bringt ${formatPercent(b.kneeAutarky)} Autarkie`;
  });

  readonly fullValue = computed(() => formatKwh(this.battery().fullAutarkyKwh, 1));
  readonly fullCaption = computed(() =>
    this.battery().fullAutarkyKwh === null
      ? 'im gemessenen Zeitraum nicht erreichbar'
      : 'deckt jede gemessene Stunde ohne Netz',
  );

  /** The figures behind the curve, as a compact line under the chart. */
  readonly facts = computed(() => {
    const b = this.battery();
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
    const b = this.battery();
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
    const curve = this.battery().curve;
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
    const b = this.battery();
    const days = this.days();
    return `Simuliert über ${days} ${days === 1 ? 'Tag' : 'Tage'} mit vollständigen Daten · ${formatPercent(
      b.efficiency,
    )} Wirkungsgrad · Laden nur aus Überschuss`;
  });
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
