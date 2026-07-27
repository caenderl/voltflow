import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { BillingMonth, BillingStatement } from '@org/shared-types';
import { CHART_COLORS, categorySeriesChart } from '../../core/chart-utils';

/**
 * The year month by month — the view's main statement. Each row says what the
 * month cost and how much of it is anchored on hand-read stands; the chart puts
 * the same figures side by side so the shape of the year is visible at a glance.
 */
@Component({
  selector: 'app-billing-months',
  standalone: true,
  imports: [DatePipe, DecimalPipe, NgxEchartsDirective],
  templateUrl: './billing-months.component.html',
  styleUrl: './billing-months.component.scss',
})
export class BillingMonthsComponent {
  readonly statement = input.required<BillingStatement>();

  readonly months = computed(() => this.statement().months);
  readonly priced = computed(() => this.statement().priced);
  readonly hasAnyData = computed(() => this.months().some((m) => m.hasData));

  /**
   * Cost above the axis, feed-in revenue below it — the same signed reading as
   * the energy charts, so "how much did this month take from me" stays the
   * distance from zero upwards. Months without data are gaps, not zeros.
   */
  readonly chart = computed(() => {
    const months = this.months();
    return categorySeriesChart(
      months.map((m) => new Date(m.month).toLocaleDateString('de-DE', { month: 'short' })),
      [
        {
          name: 'Kosten',
          color: CHART_COLORS.import,
          // importTotal, not importCost + baseFee recomputed here: the chart
          // must show the same figure the table and the card do, and only the
          // computation rounds it.
          data: months.map((m) => (m.hasData ? m.importTotal : null)),
        },
        {
          name: 'Vergütung',
          color: CHART_COLORS.export,
          data: months.map((m) => (m.hasData ? -m.exportRevenue : null)),
        },
      ],
      { legend: true, stacked: true, unit: '€' },
    );
  });

  /** Tooltip for the anchor dot — the reason a month may be less than solid. */
  anchorTitle(m: BillingMonth): string {
    if (!m.hasData) return 'Keine Daten für diesen Monat.';
    const pct = Math.round(m.measuredShare * 100);
    if (pct >= 100) return 'Vollständig durch abgelesene Zählerstände gestützt.';
    if (pct === 0) return 'Kein Zählerstand in Reichweite — vollständig aus dem SmartMeter.';
    return `${pct} % durch Zählerstände gestützt, der Rest aus dem SmartMeter verteilt.`;
  }
}
