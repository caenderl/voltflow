import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, effect, inject, signal } from '@angular/core';
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

  formProvider = '';
  formImport: number | null = null;
  formExport: number | null = null;
  formWbEnabled = false;
  formWbName = '';
  formWbHost = '';
  formWbPort: number | null = 502;
  formWbUnitId: number | null = 1;
  formWbInterval: number | null = 30;
  formSmaEnabled = false;
  formSmaName = '';
  formSmaHost = '';
  formSmaInterval: number | null = 60;

  formCpEditingId: number | null = null;
  formCpDate = toLocalDateString(new Date());
  formCpImport: number | null = null;
  formCpExport: number | null = null;

  // The config signals load asynchronously (and may not be ready when this page
  // is opened). Sync each section into the form the first time its value
  // arrives, then stop so later saves don't clobber in-progress edits.
  private tariffSynced = false;
  private wallboxSynced = false;
  private smaSynced = false;

  constructor() {
    effect(() => {
      const t = this.data.tariff();
      if (t && !this.tariffSynced) {
        this.formProvider = t.provider ?? '';
        this.formImport = t.importCtPerKwh ?? null;
        this.formExport = t.exportCtPerKwh ?? null;
        this.tariffSynced = true;
      }
    });
    effect(() => {
      const w = this.data.wallboxConfig();
      if (w && !this.wallboxSynced) {
        this.formWbEnabled = w.enabled ?? false;
        this.formWbName = w.name ?? '';
        this.formWbHost = w.host ?? '';
        this.formWbPort = w.port ?? 502;
        this.formWbUnitId = w.unitId ?? 1;
        this.formWbInterval = w.pollIntervalS ?? 30;
        this.wallboxSynced = true;
      }
    });
    effect(() => {
      const s = this.data.smaConfig();
      if (s && !this.smaSynced) {
        this.formSmaEnabled = s.enabled ?? false;
        this.formSmaName = s.name ?? '';
        this.formSmaHost = s.host ?? '';
        this.formSmaInterval = s.pollIntervalS ?? 60;
        this.smaSynced = true;
      }
    });
  }

  save(): void {
    this.saveError.set(false);
    void this.data
      .saveConfig({
        tariff: {
          provider: this.formProvider.trim() || null,
          importCtPerKwh: this.formImport ?? null,
          exportCtPerKwh: this.formExport ?? null,
        },
        wallbox: {
          enabled: this.formWbEnabled,
          name: this.formWbName.trim() || null,
          host: this.formWbHost.trim() || null,
          port: this.formWbPort ?? 502,
          unitId: this.formWbUnitId ?? 1,
          pollIntervalS: this.formWbInterval ?? 30,
        },
        sma: {
          enabled: this.formSmaEnabled,
          name: this.formSmaName.trim() || null,
          host: this.formSmaHost.trim() || null,
          pollIntervalS: this.formSmaInterval ?? 60,
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
    this.formCpEditingId = null;
    this.formCpDate = toLocalDateString(new Date());
    this.formCpImport = null;
    this.formCpExport = null;
  }

  editCheckpoint(c: MeterCheckpoint): void {
    this.formCpEditingId = c.id;
    this.formCpDate = c.date;
    this.formCpImport = c.importKwh;
    this.formCpExport = c.exportKwh;
  }

  saveCheckpoint(): void {
    if (!this.formCpDate || this.formCpImport == null || this.formCpExport == null) return;
    this.data.saveCheckpoint({
      id: this.formCpEditingId ?? undefined,
      date: this.formCpDate,
      importKwh: this.formCpImport,
      exportKwh: this.formCpExport,
    });
    this.resetCheckpointForm();
  }

  deleteCheckpoint(c: MeterCheckpoint): void {
    if (this.formCpEditingId === c.id) this.resetCheckpointForm();
    this.data.deleteCheckpoint(c.id);
  }
}
