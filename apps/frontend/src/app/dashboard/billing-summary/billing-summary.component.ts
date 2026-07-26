import { DecimalPipe, PercentPipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import type { BillingStatement } from '@org/shared-types';

/**
 * The year's bottom line: energy, cost, revenue and the standing charge, plus
 * how well the year is anchored on hand-read stands. Kept separate from the
 * month table so the headline figures own their own responsive layout.
 */
@Component({
  selector: 'app-billing-summary',
  standalone: true,
  imports: [DecimalPipe, PercentPipe],
  templateUrl: './billing-summary.component.html',
  styleUrl: './billing-summary.component.scss',
})
export class BillingSummaryComponent {
  readonly statement = input.required<BillingStatement>();

  readonly totals = computed(() => this.statement().totals);

  /**
   * How the year is anchored, in words. The share alone invites over-reading a
   * number like 0.87; what matters is whether readings exist at all and how much
   * of the year rests on the smart meter instead.
   */
  readonly anchorNote = computed(() => {
    const s = this.statement();
    const share = s.totals.measuredShare;
    const readings = s.readings;
    if (readings === 0) {
      return 'Keine Ablesung in diesem Jahr — alle Werte stammen aus dem SmartMeter.';
    }
    const r = `${readings} ${readings === 1 ? 'Ablesung' : 'Ablesungen'}`;
    if (share >= 0.999) return `${r} — jede kWh liegt zwischen zwei Zählerständen.`;
    return `${r} — der Rest ist aus dem SmartMeter geschätzt.`;
  });
}
