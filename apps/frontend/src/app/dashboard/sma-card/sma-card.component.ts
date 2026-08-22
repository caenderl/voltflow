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
  /** Null while this instance has never reported — see DeviceCard. */
  readonly state = input.required<SmaState | null>();
  readonly name = input<string>('PV-Anlage');
  /** Today's energy balance (self-consumption / autarky), if available. */
  readonly balance = input<EnergyBalance | null>(null);

  readonly producing = computed(() => {
    const s = this.state();
    return s !== null && !s.asleep && s.productionW > 0;
  });
  readonly stale = computed(() => this.state()?.stale ?? false);
  readonly statusLabel = computed(() => {
    const s = this.state();
    if (s === null) return 'Nicht verbunden';
    if (s.stale) return 'Veraltet';
    if (s.asleep) return 'Schläft';
    return s.productionW > 0 ? 'Produziert' : 'Standby';
  });
}
