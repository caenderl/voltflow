import { Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LiveReadingCardComponent } from '../../ui/live-reading-card/live-reading-card.component';

export interface WallboxState {
  statusLabel: string;
  charging: boolean;
  powerW: number;
  sessionKwh: number;
  /** No reading in a while (device likely offline) - see dashboard-data.service. */
  stale: boolean;
}

@Component({
  selector: 'app-wallbox-card',
  standalone: true,
  imports: [CommonModule, LiveReadingCardComponent],
  templateUrl: './wallbox-card.component.html',
  styleUrl: './wallbox-card.component.scss',
})
export class WallboxCardComponent {
  /** Null while this instance has never reported — see DeviceCard. */
  readonly state = input.required<WallboxState | null>();
  readonly name = input<string>('Wallbox');

  readonly charging = computed(() => this.state()?.charging ?? false);
  readonly stale = computed(() => this.state()?.stale ?? false);
  readonly statusLabel = computed(() => {
    const s = this.state();
    if (s === null) return 'Nicht verbunden';
    return s.stale ? 'Veraltet' : s.statusLabel;
  });
}
