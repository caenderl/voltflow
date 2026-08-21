import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { DashboardDataService } from '../../dashboard/dashboard-data.service';
import { SettingsCardComponent } from '../../ui/settings-card/settings-card.component';
import { ToggleSwitchComponent } from '../../ui/toggle-switch/toggle-switch.component';

/**
 * "Konfiguration" section: display-level app settings (currently just
 * calibration). Device connections live in their own "Geräte" section — a
 * list of instances, not a single form, ever since a device kind stopped
 * meaning exactly one device.
 */
@Component({
  selector: 'app-config-section',
  standalone: true,
  imports: [RouterLink, SettingsCardComponent, ToggleSwitchComponent, DecimalPipe],
  templateUrl: './config-section.component.html',
  styleUrl: './config-section.component.scss',
})
export class ConfigSectionComponent {
  private readonly data = inject(DashboardDataService);
  private readonly router = inject(Router);

  readonly saveError = signal(false);

  // appSettings loads asynchronously (and may not be ready when this page is
  // opened directly). linkedSignal seeds the field from the loaded value and
  // re-seeds if it arrives late, while still letting the user overwrite it -
  // no manual "synced" flag and no post-render write (which would trip
  // NG0100). It only changes again on our own save, after which we navigate
  // away, so an in-progress edit is never clobbered.
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

  save(): void {
    this.saveError.set(false);
    void this.data
      .saveConfig({ calibrationEnabled: this.formCalibration() })
      .then((ok) => {
        // Leave the page on success (like the old modal closing); keep it open
        // with an error note otherwise.
        if (ok) this.router.navigate(['/live']);
        else this.saveError.set(true);
      });
  }
}
