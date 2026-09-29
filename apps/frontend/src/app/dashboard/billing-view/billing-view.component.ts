import { Component, input, output } from '@angular/core';
import type { BillingStatement } from '@org/shared-types';
import { BillingMonthsComponent } from '../billing-months/billing-months.component';
import { BillingPeriodsComponent } from '../billing-periods/billing-periods.component';
import { BillingSummaryComponent } from '../billing-summary/billing-summary.component';

/**
 * Presentational shell of the billing view: year navigation plus the three
 * sections. Holds no state — the container owns the year and the loading.
 */
@Component({
  selector: 'app-billing-view',
  standalone: true,
  imports: [BillingSummaryComponent, BillingMonthsComponent, BillingPeriodsComponent],
  templateUrl: './billing-view.component.html',
  styleUrl: './billing-view.component.scss',
})
export class BillingViewComponent {
  readonly statement = input<BillingStatement | null>(null);
  readonly year = input.required<number>();
  readonly canPrev = input<boolean>(false);
  readonly canNext = input<boolean>(false);
  readonly loading = input<boolean>(false);
  readonly error = input<string | null>(null);

  readonly prevClicked = output<void>();
  readonly nextClicked = output<void>();
}
