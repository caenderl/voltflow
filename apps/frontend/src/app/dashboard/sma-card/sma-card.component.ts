import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { EnergyBalance } from '@org/shared-types';

export interface SmaState {
  productionW: number;
  dailyYieldKwh: number;
  asleep: boolean;
}

@Component({
  selector: 'app-sma-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './sma-card.component.html',
  styleUrl: './sma-card.component.scss',
})
export class SmaCardComponent {
  readonly state = input.required<SmaState>();
  readonly name = input<string>('PV-Anlage');
  /** Today's energy balance (self-consumption / autarky), if available. */
  readonly balance = input<EnergyBalance | null>(null);
}
