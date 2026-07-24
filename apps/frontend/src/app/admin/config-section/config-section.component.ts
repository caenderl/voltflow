import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DashboardDataService } from '../../dashboard/dashboard-data.service';
import { NumberFieldComponent } from '../../ui/number-field/number-field.component';
import { SettingsCardComponent } from '../../ui/settings-card/settings-card.component';
import { TextFieldComponent } from '../../ui/text-field/text-field.component';
import { ToggleSwitchComponent } from '../../ui/toggle-switch/toggle-switch.component';

/**
 * "Konfiguration" section: display + wallbox + PV-inverter settings stacked as
 * cards with a shared Abbrechen/Speichern footer. Owns the config form state.
 * (Tariffs live in their own section — they are a time-ranged list, not a
 * single form.)
 */
@Component({
  selector: 'app-config-section',
  standalone: true,
  imports: [
    RouterLink,
    SettingsCardComponent,
    ToggleSwitchComponent,
    TextFieldComponent,
    NumberFieldComponent,
    DecimalPipe,
  ],
  templateUrl: './config-section.component.html',
  styleUrl: './config-section.component.scss',
})
export class ConfigSectionComponent {
  private readonly data = inject(DashboardDataService);
  private readonly router = inject(Router);

  readonly saveError = signal(false);

  // The config signals load asynchronously (and may not be ready when this page
  // is opened directly). linkedSignal seeds each field from the loaded value
  // and re-seeds if it arrives late, while still letting the user overwrite it -
  // no manual "synced" flags and no post-render writes (which would trip
  // NG0100). The config only changes again on our own save, after which we
  // navigate away, so in-progress edits are never clobbered.
  readonly formCalibration = linkedSignal(
    () => this.data.appSettings()?.calibrationEnabled ?? false,
  );

  /**
   * The active correction factors (physical / smart) from the checkpoint
   * reconciliation, or null when there is no comparable checkpoint pair to
   * derive them from. Shown in the card so the user sees what the toggle
   * actually applies; also gates the toggle, which is inert without them.
   */
  readonly calibrationFactors = computed(() => {
    const t = this.data.reconciliation()?.totals;
    if (t?.importFactor == null || t?.exportFactor == null) return null;
    return { importFactor: t.importFactor, exportFactor: t.exportFactor };
  });

  /** Whether both correction factors exist — the toggle is inert without either. */
  readonly hasCalibrationData = computed(() => this.calibrationFactors() !== null);
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

  save(): void {
    this.saveError.set(false);
    void this.data
      .saveConfig({
        appSettings: {
          calibrationEnabled: this.formCalibration(),
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
}
