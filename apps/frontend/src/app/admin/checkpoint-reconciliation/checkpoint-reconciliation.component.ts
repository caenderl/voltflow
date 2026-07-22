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

/** One clause of the verdict, e.g. "Bezug stimmt praktisch exakt" or null without data. */
function describeDeviation(pct: number | null, label: string): string | null {
  if (pct === null) return null;
  if (Math.abs(pct) < 0.05) return `${label} stimmt praktisch exakt`;
  const direction = pct < 0 ? 'zu niedrig' : 'zu hoch';
  return `${label} ${Math.abs(pct).toFixed(2).replace('.', ',')} % ${direction}`;
}

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

  /**
   * One-line verdict on the smart meter's accuracy, or null without totals.
   * Covers both directions, since a CT-clamp meter can plausibly measure
   * import and export with different accuracy — a headline about Bezug alone
   * would hide a deviation on the Einspeisung side.
   */
  readonly verdict = computed(() => {
    const t = this.totals();
    if (t === null) return null;
    const clauses = [
      describeDeviation(t.importDeviationPct, 'Bezug'),
      describeDeviation(t.exportDeviationPct, 'Einspeisung'),
    ].filter((c): c is string => c !== null);
    if (!clauses.length) return null;
    return `Das SmartMeter misst über ${t.days} Tage: ${clauses.join(', ')}.`;
  });

  statusHint(status: ReconciliationStatus): string {
    return STATUS_HINT[status];
  }
}
