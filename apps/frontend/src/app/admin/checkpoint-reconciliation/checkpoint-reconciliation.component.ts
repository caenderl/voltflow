import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import type { ReconciliationStatus } from '@org/shared-types';
import { DashboardDataService } from '../../dashboard/dashboard-data.service';
import { SettingsCardComponent } from '../../ui/settings-card/settings-card.component';

/** Explains a row the comparison had to skip. */
const STATUS_HINT: Record<ReconciliationStatus, string> = {
  ok: '',
  'no-data': 'Kein SmartMeter-Wert um die Ablesezeit an einem der beiden Tage.',
  reset: 'Der Zählerstand ist rückwärts gesprungen (Gerätetausch oder Tippfehler).',
};

/**
 * "Abgleich mit dem SmartMeter": per interval between two checkpoints, what the
 * physical meter counted vs. what the smart meter counted over the same span.
 */
@Component({
  selector: 'app-checkpoint-reconciliation',
  standalone: true,
  imports: [DatePipe, DecimalPipe, SettingsCardComponent],
  templateUrl: './checkpoint-reconciliation.component.html',
  styleUrl: './checkpoint-reconciliation.component.scss',
})
export class CheckpointReconciliationComponent {
  private readonly data = inject(DashboardDataService);

  readonly intervals = computed(() => this.data.reconciliation()?.intervals ?? []);
  readonly totals = computed(() => this.data.reconciliation()?.totals ?? null);

  /** One-line verdict on the smart meter's accuracy, or null without totals. */
  readonly verdict = computed(() => {
    const t = this.totals();
    if (t === null || t.importDeviationPct === null) return null;
    const pct = t.importDeviationPct;
    const direction = pct < 0 ? 'zu niedrig' : 'zu hoch';
    if (Math.abs(pct) < 0.05) {
      return `Das SmartMeter deckt sich über ${t.days} Tage praktisch exakt mit dem Zähler.`;
    }
    return `Das SmartMeter misst den Bezug über ${t.days} Tage um ${Math.abs(pct)
      .toFixed(2)
      .replace('.', ',')} % ${direction}.`;
  });

  statusHint(status: ReconciliationStatus): string {
    return STATUS_HINT[status];
  }
}
