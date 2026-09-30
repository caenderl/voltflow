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
  /** No fresh meter reading in a while — the figure below is not current. */
  stale: boolean;
}

/**
 * One device card in the live view: which configured instance it is, what to
 * call it, and its current state — or null while that instance has never
 * reported. A configured device that has not connected still gets a card:
 * "enabled but silent" is a thing the user needs to see, and it is exactly the
 * state a wrong IP address produces.
 */
export interface DeviceCard<S> {
  /** `device_config.id` — the card's identity across re-renders. */
  id: number;
  name: string;
  state: S | null;
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
  /** One card per enabled instance, not one per device kind. */
  readonly smaCards = input<DeviceCard<SmaState>[]>([]);
  readonly wallboxCards = input<DeviceCard<WallboxState>[]>([]);
  /**
   * Today's self-consumption / autarky. A property of the *house*, not of any
   * one inverter, so it is rendered on the first producer card only — repeating
   * it under a second inverter would read as that inverter's own figure.
   */
  readonly balance = input<EnergyBalance | null>(null);
}
