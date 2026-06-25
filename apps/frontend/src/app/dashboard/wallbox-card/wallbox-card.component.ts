import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface WallboxState {
  statusLabel: string;
  charging: boolean;
  powerW: number;
  sessionKwh: number;
}

@Component({
  selector: 'app-wallbox-card',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './wallbox-card.component.html',
  styleUrl: './wallbox-card.component.scss',
})
export class WallboxCardComponent {
  readonly state = input.required<WallboxState>();
  readonly name = input<string>('Wallbox');
}
