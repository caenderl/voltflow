import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, inject, linkedSignal, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type { MeterCheckpoint } from '@org/shared-types';
import type { ConfigTab } from '../core/config-types';
import { toLocalDateString } from '../core/date-utils';
import { DashboardDataService } from '../dashboard/dashboard-data.service';

@Component({
  selector: 'app-admin-page',
  standalone: true,
  imports: [FormsModule, DatePipe, DecimalPipe, RouterLink],
  templateUrl: './admin-page.component.html',
  styleUrl: './admin-page.component.scss',
})
export class AdminPageComponent {
  private readonly data = inject(DashboardDataService);
  private readonly router = inject(Router);

  readonly checkpoints = this.data.checkpoints;

  readonly activeTab = signal<ConfigTab>('tariff');
  readonly saveError = signal(false);

  // The config signals load asynchronously (and may not be ready when this page
  // is opened directly). linkedSignal seeds each field from the loaded value
  // and re-seeds if it arrives late, while still letting the user overwrite it -
  // no manual "synced" flags and no post-render writes (which would trip
  // NG0100). The config only changes again on our own save, after which we
  // navigate away, so in-progress edits are never clobbered.
  readonly formProvider = linkedSignal(() => this.data.tariff()?.provider ?? '');
  readonly formImport = linkedSignal(() => this.data.tariff()?.importCtPerKwh ?? null);
  readonly formExport = linkedSignal(() => this.data.tariff()?.exportCtPerKwh ?? null);
  readonly formWbEnabled = linkedSignal(() => this.data.wallboxConfig()?.enabled ?? false);
  readonly formWbName = linkedSignal(() => this.data.wallboxConfig()?.name ?? '');
  readonly formWbHost = linkedSignal(() => this.data.wallboxConfig()?.host ?? '');
  // Number fields are `number | null`: clearing the input sets null (save() then
  // falls back to the default), so the type must admit it.
  readonly formWbPort = linkedSignal<number | null>(() => this.data.wallboxConfig()?.port ?? 502);
  readonly formWbUnitId = linkedSignal<number | null>(() => this.data.wallboxConfig()?.unitId ?? 1);
  readonly formWbInterval = linkedSignal<number | null>(
    () => this.data.wallboxConfig()?.pollIntervalS ?? 30,
  );
  readonly formSmaEnabled = linkedSignal(() => this.data.smaConfig()?.enabled ?? false);
  readonly formSmaName = linkedSignal(() => this.data.smaConfig()?.name ?? '');
  readonly formSmaHost = linkedSignal(() => this.data.smaConfig()?.host ?? '');
  readonly formSmaInterval = linkedSignal<number | null>(
    () => this.data.smaConfig()?.pollIntervalS ?? 60,
  );

  // Checkpoint editor state - plain transient UI state, not derived from config.
  readonly formCpEditingId = signal<number | null>(null);
  readonly formCpDate = signal(toLocalDateString(new Date()));
  readonly formCpImport = signal<number | null>(null);
  readonly formCpExport = signal<number | null>(null);

  save(): void {
    this.saveError.set(false);
    void this.data
      .saveConfig({
        tariff: {
          provider: this.formProvider().trim() || null,
          importCtPerKwh: this.formImport() ?? null,
          exportCtPerKwh: this.formExport() ?? null,
        },
        wallbox: {
          enabled: this.formWbEnabled(),
          name: this.formWbName().trim() || null,
          host: this.formWbHost().trim() || null,
          port: this.formWbPort() ?? 502,
          unitId: this.formWbUnitId() ?? 1,
          pollIntervalS: this.formWbInterval() ?? 30,
        },
        sma: {
          enabled: this.formSmaEnabled(),
          name: this.formSmaName().trim() || null,
          host: this.formSmaHost().trim() || null,
          pollIntervalS: this.formSmaInterval() ?? 60,
        },
      })
      .then((ok) => {
        // Leave the page on success (like the old modal closing); keep it open
        // with an error note otherwise.
        if (ok) this.router.navigate(['/live']);
        else this.saveError.set(true);
      });
  }

  resetCheckpointForm(): void {
    this.formCpEditingId.set(null);
    this.formCpDate.set(toLocalDateString(new Date()));
    this.formCpImport.set(null);
    this.formCpExport.set(null);
  }

  editCheckpoint(c: MeterCheckpoint): void {
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
    this.resetCheckpointForm();
  }

  deleteCheckpoint(c: MeterCheckpoint): void {
    if (this.formCpEditingId() === c.id) this.resetCheckpointForm();
    this.data.deleteCheckpoint(c.id);
  }
}
