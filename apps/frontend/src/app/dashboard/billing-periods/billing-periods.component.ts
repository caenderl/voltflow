import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, input, signal } from '@angular/core';
import type { BillingPeriod } from '@org/shared-types';

/**
 * The reading intervals the year rests on. Collapsed by default: the months are
 * the statement, this is the evidence behind them — kept reachable so a
 * surprising month can be traced back to the stands it was derived from.
 */
@Component({
  selector: 'app-billing-periods',
  standalone: true,
  imports: [DatePipe, DecimalPipe],
  templateUrl: './billing-periods.component.html',
  styleUrl: './billing-periods.component.scss',
})
export class BillingPeriodsComponent {
  readonly periods = input.required<BillingPeriod[]>();

  readonly open = signal(false);

  toggle(): void {
    this.open.update((v) => !v);
  }
}
