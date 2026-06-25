import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsCoreOption } from 'echarts/core';
import type { EnergySummary } from '@org/shared-types';
import { WallboxCardComponent, type WallboxState } from '../wallbox-card/wallbox-card.component';

export type FlowMode = 'export' | 'import' | 'idle';

export interface FlowState {
  mode: FlowMode;
  watts: number;
  charging: boolean;
}

@Component({
  selector: 'app-live-view',
  standalone: true,
  imports: [CommonModule, NgxEchartsDirective, WallboxCardComponent],
  templateUrl: './live-view.component.html',
  styleUrl: './live-view.component.scss',
})
export class LiveViewComponent {
  readonly flow = input.required<FlowState>();
  readonly today = input<EnergySummary | null>(null);
  readonly liveSpark = input.required<EChartsCoreOption>();
  readonly wallboxState = input<WallboxState | null>(null);
  readonly wallboxName = input<string>('Wallbox');
}
