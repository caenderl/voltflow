import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsCoreOption } from 'echarts/core';
import type { EnergyBalance, EnergySummary } from '@org/shared-types';
import { WallboxCardComponent, type WallboxState } from '../wallbox-card/wallbox-card.component';
import { SmaCardComponent, type SmaState } from '../sma-card/sma-card.component';

export type FlowMode = 'export' | 'import' | 'idle';

export interface FlowState {
  mode: FlowMode;
  watts: number;
  charging: boolean;
}

@Component({
  selector: 'app-live-view',
  standalone: true,
  imports: [CommonModule, NgxEchartsDirective, WallboxCardComponent, SmaCardComponent],
  templateUrl: './live-view.component.html',
  styleUrl: './live-view.component.scss',
})
export class LiveViewComponent {
  readonly flow = input.required<FlowState>();
  readonly today = input<EnergySummary | null>(null);
  /** Whether today's Bezug/Einspeisung are corrected onto the physical meter. */
  readonly calibrated = input<boolean>(false);
  readonly liveSpark = input.required<EChartsCoreOption>();
  readonly wallboxState = input<WallboxState | null>(null);
  readonly wallboxName = input<string>('Wallbox');
  readonly smaState = input<SmaState | null>(null);
  readonly smaName = input<string>('PV-Anlage');
  readonly balance = input<EnergyBalance | null>(null);
}
