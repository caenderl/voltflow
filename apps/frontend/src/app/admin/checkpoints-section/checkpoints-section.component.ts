import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import type { MeterCheckpoint } from '@org/shared-types';
import { toLocalDateString } from '../../core/date-utils';
import { DashboardDataService } from '../../dashboard/dashboard-data.service';
import { NumberFieldComponent } from '../../ui/number-field/number-field.component';
import { SettingsCardComponent } from '../../ui/settings-card/settings-card.component';
import { TextFieldComponent } from '../../ui/text-field/text-field.component';

/**
 * "Zählerstände" section: add/edit form plus a table of recorded meter
 * checkpoints. Owns the checkpoint editor state; saves take effect immediately
 * (no shared footer).
 */
@Component({
  selector: 'app-checkpoints-section',
  standalone: true,
  imports: [DatePipe, DecimalPipe, SettingsCardComponent, TextFieldComponent, NumberFieldComponent],
  templateUrl: './checkpoints-section.component.html',
  styleUrl: './checkpoints-section.component.scss',
})
export class CheckpointsSectionComponent {
  private readonly data = inject(DashboardDataService);

  readonly checkpoints = this.data.checkpoints;

  // Plain transient UI state, not derived from config.
  readonly formCpEditingId = signal<number | null>(null);
  readonly formCpDate = signal(toLocalDateString(new Date()));
  readonly formCpImport = signal<number | null>(null);
  readonly formCpExport = signal<number | null>(null);

  resetForm(): void {
    this.formCpEditingId.set(null);
    this.formCpDate.set(toLocalDateString(new Date()));
    this.formCpImport.set(null);
    this.formCpExport.set(null);
  }

  edit(c: MeterCheckpoint): void {
    this.formCpEditingId.set(c.id);
    this.formCpDate.set(c.date);
    this.formCpImport.set(c.importKwh);
    this.formCpExport.set(c.exportKwh);
  }

  saveCheckpoint(): void {
    const date = this.formCpDate();
    const importKwh = this.formCpImport();
    const exportKwh = this.formCpExport();
    if (!date || importKwh == null || exportKwh == null) return;
    this.data.saveCheckpoint({
      id: this.formCpEditingId() ?? undefined,
      date,
      importKwh,
      exportKwh,
    });
    this.resetForm();
  }

  deleteCheckpoint(c: MeterCheckpoint): void {
    if (this.formCpEditingId() === c.id) this.resetForm();
    this.data.deleteCheckpoint(c.id);
  }
}
