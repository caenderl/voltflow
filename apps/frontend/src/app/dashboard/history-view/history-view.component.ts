import { Component, input, output } from '@angular/core';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsCoreOption } from 'echarts/core';
import type { EnergyBalance, EnergySummary } from '@org/shared-types';
import type { View } from '../../core/date-utils';
import { HistorySummaryComponent, type Costs } from '../history-summary/history-summary.component';

@Component({
  selector: 'app-history-view',
  standalone: true,
  imports: [NgxEchartsDirective, HistorySummaryComponent],
  templateUrl: './history-view.component.html',
  styleUrl: './history-view.component.scss',
})
export class HistoryViewComponent {
  readonly view = input.required<View>();
  readonly periodLabel = input.required<string>();
  readonly canPrev = input<boolean>(false);
  readonly canNext = input<boolean>(false);
  readonly energy = input<EnergySummary | null>(null);
  readonly hasTariff = input<boolean>(false);
  readonly costs = input<Costs | null>(null);
  readonly balance = input<EnergyBalance | null>(null);
  readonly loading = input<boolean>(false);
  readonly error = input<string | null>(null);
  readonly powerChart = input.required<EChartsCoreOption>();
  readonly energyChart = input.required<EChartsCoreOption>();
  readonly pvChart = input<EChartsCoreOption | null>(null);
  readonly wallboxChart = input<EChartsCoreOption | null>(null);

  readonly prevClicked = output<void>();
  readonly nextClicked = output<void>();
}
