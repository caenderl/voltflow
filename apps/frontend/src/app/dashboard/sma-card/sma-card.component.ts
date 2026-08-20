import { Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { EnergyBalance } from '@org/shared-types';
import { LiveReadingCardComponent } from '../../ui/live-reading-card/live-reading-card.component';

export interface SmaState {
  productionW: number;
  dailyYieldKwh: number;
  asleep: boolean;
  /** No reading in a while (device likely offline) - see dashboard-data.service. */
  stale: boolean;
}

@Component({
  selector: 'app-sma-card',
  standalone: true,
  imports: [CommonModule, LiveReadingCardComponent],
  templateUrl: './sma-card.component.html',
  styleUrl: './sma-card.component.scss',
})
export class SmaCardComponent {
  readonly state = input.required<SmaState>();
  readonly name = input<string>('PV-Anlage');
  /** Today's energy balance (self-consumption / autarky), if available. */
  readonly balance = input<EnergyBalance | null>(null);

  readonly producing = computed(() => !this.state().asleep && this.state().productionW > 0);
  readonly statusLabel = computed(() => {
    if (this.state().stale) return 'Veraltet';
    if (this.state().asleep) return 'Schläft';
    return this.state().productionW > 0 ? 'Produziert' : 'Standby';
  });
}
