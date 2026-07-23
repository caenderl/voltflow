import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import type { EnergyBalance, EnergySummary } from '@org/shared-types';
import type { Costs } from '../../core/costs';

/**
 * The KPI summary of a history period (energy totals + PV balance), split from
 * HistoryView so the responsive card logic lives on its own. Desktop renders
 * the metrics as separate cards (2 rows of 3); on phones (<=540px) each group
 * collapses into a single card whose metrics become cells - Bezug|Einspeisung
 * with Netto below, and PV-Erzeugung above Eigenverbrauch|Autarkie - to reclaim
 * vertical space.
 */
@Component({
  selector: 'app-history-summary',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './history-summary.component.html',
  styleUrl: './history-summary.component.scss',
})
export class HistorySummaryComponent {
  readonly energy = input<EnergySummary | null>(null);
  /** Whether the energy/cost figures are corrected onto the physical meter. */
  readonly calibrated = input<boolean>(false);
  readonly hasTariff = input<boolean>(false);
  readonly costs = input<Costs | null>(null);
  readonly balance = input<EnergyBalance | null>(null);
}
