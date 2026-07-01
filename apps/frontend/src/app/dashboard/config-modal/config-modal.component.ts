import { Component, OnInit, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SmaConfig, Tariff, WallboxConfig } from '@org/shared-types';

export interface ConfigSaveEvent {
  tariff: Tariff;
  wallbox: WallboxConfig;
  sma: SmaConfig;
}

export type ConfigTab = 'tariff' | 'wallbox' | 'sma';

@Component({
  selector: 'app-config-modal',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './config-modal.component.html',
  styleUrl: './config-modal.component.scss',
})
export class ConfigModalComponent implements OnInit {
  readonly tariff = input<Tariff | null>(null);
  readonly wallboxConfig = input<WallboxConfig | null>(null);
  readonly smaConfig = input<SmaConfig | null>(null);

  readonly closed = output<void>();
  readonly saved = output<ConfigSaveEvent>();

  readonly activeTab = signal<ConfigTab>('tariff');

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

  ngOnInit(): void {
    const t = this.tariff();
    this.formProvider = t?.provider ?? '';
    this.formImport = t?.importCtPerKwh ?? null;
    this.formExport = t?.exportCtPerKwh ?? null;
    const w = this.wallboxConfig();
    this.formWbEnabled = w?.enabled ?? false;
    this.formWbName = w?.name ?? '';
    this.formWbHost = w?.host ?? '';
    this.formWbPort = w?.port ?? 502;
    this.formWbUnitId = w?.unitId ?? 1;
    this.formWbInterval = w?.pollIntervalS ?? 30;
    const s = this.smaConfig();
    this.formSmaEnabled = s?.enabled ?? false;
    this.formSmaName = s?.name ?? '';
    this.formSmaHost = s?.host ?? '';
    this.formSmaInterval = s?.pollIntervalS ?? 60;
  }

  save(): void {
    this.saved.emit({
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
    });
  }
}
