import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { DashboardDataService } from '../../dashboard/dashboard-data.service';
import { SettingsCardComponent } from '../../ui/settings-card/settings-card.component';

/**
 * "Geschätzter Zählerstand": the physical meter reading extrapolated to now
 * from the newest checkpoint plus what the smart meter has counted since — so
 * the current reading is available without walking to the meter.
 */
@Component({
  selector: 'app-checkpoint-projection',
  standalone: true,
  imports: [DatePipe, DecimalPipe, SettingsCardComponent],
  templateUrl: './checkpoint-projection.component.html',
  styleUrl: './checkpoint-projection.component.scss',
})
export class CheckpointProjectionComponent {
  private readonly data = inject(DashboardDataService);

  readonly projection = computed(() => this.data.reconciliation()?.projection ?? null);

  /** Why there is nothing to project, for the empty state. */
  readonly emptyReason = computed(() =>
    this.data.checkpoints().length === 0
      ? 'Noch keine Zählerstände erfasst — der erste Stand ist der Startpunkt für die Hochrechnung.'
      : 'Für den erfassten Zählerstand gibt es keine SmartMeter-Daten um die Ablesezeit, daher ist keine Hochrechnung möglich.',
  );
}
