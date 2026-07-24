import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import type { TariffPeriod } from '@org/shared-types';
import { toLocalDateString } from '../../core/date-utils';
import { DashboardDataService } from '../../dashboard/dashboard-data.service';
import { NumberFieldComponent } from '../../ui/number-field/number-field.component';
import { SettingsCardComponent } from '../../ui/settings-card/settings-card.component';
import { TextFieldComponent } from '../../ui/text-field/text-field.component';

/**
 * "Tarife" section: add/edit form plus a table of time-ranged electricity
 * tariffs. Each tariff applies from its start date until the next begins; the
 * oldest extends backward. Saves take effect immediately (no shared footer).
 */
@Component({
  selector: 'app-tariffs-section',
  standalone: true,
  imports: [DatePipe, DecimalPipe, SettingsCardComponent, TextFieldComponent, NumberFieldComponent],
  templateUrl: './tariffs-section.component.html',
  styleUrl: './tariffs-section.component.scss',
})
export class TariffsSectionComponent {
  private readonly data = inject(DashboardDataService);

  readonly tariffs = this.data.tariffPeriods;
  /** Save/delete failures — without this a rejected date fails silently here. */
  readonly error = this.data.error;

  readonly formEditingId = signal<number | null>(null);
  readonly formValidFrom = signal(toLocalDateString(new Date()));
  readonly formProvider = signal('');
  readonly formImport = signal<number | null>(null);
  readonly formExport = signal<number | null>(null);

  resetForm(): void {
    this.formEditingId.set(null);
    this.formValidFrom.set(toLocalDateString(new Date()));
    this.formProvider.set('');
    this.formImport.set(null);
    this.formExport.set(null);
  }

  edit(t: TariffPeriod): void {
    this.formEditingId.set(t.id);
    this.formValidFrom.set(t.validFrom);
    this.formProvider.set(t.provider ?? '');
    this.formImport.set(t.importCtPerKwh);
    this.formExport.set(t.exportCtPerKwh);
  }

  save(): void {
    const validFrom = this.formValidFrom();
    if (!validFrom) return;
    // Reset only once the save actually lands — on a 409 the form must keep the
    // user's input so they can see what conflicted instead of losing it.
    void this.data
      .saveTariffPeriod({
        id: this.formEditingId() ?? undefined,
        validFrom,
        provider: this.formProvider().trim() || null,
        importCtPerKwh: this.formImport(),
        exportCtPerKwh: this.formExport(),
      })
      .then((ok) => {
        if (ok) this.resetForm();
      });
  }

  remove(t: TariffPeriod): void {
    if (this.formEditingId() === t.id) this.resetForm();
    this.data.deleteTariffPeriod(t.id);
  }
}
