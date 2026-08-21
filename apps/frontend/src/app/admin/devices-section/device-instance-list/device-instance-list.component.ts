import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import type { DeviceConfig, DeviceDriver } from '@org/shared-types';
import { DashboardDataService } from '../../../dashboard/dashboard-data.service';
import { NumberFieldComponent } from '../../../ui/number-field/number-field.component';
import { SettingsCardComponent } from '../../../ui/settings-card/settings-card.component';
import { TextFieldComponent } from '../../../ui/text-field/text-field.component';
import { ToggleSwitchComponent } from '../../../ui/toggle-switch/toggle-switch.component';

/**
 * Add/edit form plus a table of configured instances for one driver - the
 * per-device-kind analog of the tariffs section's list+form (saves take
 * effect immediately, no shared footer). Instantiated once per driver by
 * `DevicesSectionComponent`; owns its own form state so the SMA and Wallbox
 * cards on the same tab never share one in-progress edit.
 *
 * Deliberately does not read `DashboardDataService.error` for its own
 * messages: two cards render at once here (unlike every other admin section,
 * which is alone on its tab), and a shared signal would risk a Wallbox
 * failure surfacing under the SMA card. A local, fixed message avoids that
 * regardless of which card actually failed.
 */
@Component({
  selector: 'app-device-instance-list',
  standalone: true,
  imports: [SettingsCardComponent, ToggleSwitchComponent, TextFieldComponent, NumberFieldComponent],
  templateUrl: './device-instance-list.component.html',
  styleUrl: './device-instance-list.component.scss',
})
export class DeviceInstanceListComponent implements OnInit {
  private readonly data = inject(DashboardDataService);

  /** Immutable for the lifetime of one instance — driver never changes on an edit. */
  readonly driver = input.required<DeviceDriver>();
  readonly heading = input.required<string>();
  readonly subtitle = input<string>('');
  readonly devices = input.required<DeviceConfig[]>();

  readonly isModbus = computed(() => this.driver() === 'anker-v1-modbus');

  readonly formEditingId = signal<number | null>(null);
  readonly formName = signal('');
  readonly formEnabled = signal(false);
  readonly formHost = signal('');
  readonly formPort = signal<number | null>(null);
  readonly formUnitId = signal<number | null>(null);
  readonly formInterval = signal<number | null>(null);
  readonly formError = signal<string | null>(null);

  // Required signal inputs are not yet bound during construction (reading
  // them there throws NG0950) — seed the form once Angular has set them.
  ngOnInit(): void {
    this.resetForm();
  }

  resetForm(): void {
    this.formEditingId.set(null);
    this.formName.set('');
    this.formEnabled.set(false);
    this.formHost.set('');
    this.formPort.set(this.isModbus() ? 502 : null);
    this.formUnitId.set(this.isModbus() ? 1 : null);
    this.formInterval.set(this.isModbus() ? 30 : 60);
    this.formError.set(null);
  }

  edit(d: DeviceConfig): void {
    this.formEditingId.set(d.id);
    this.formName.set(d.name ?? '');
    this.formEnabled.set(d.enabled);
    this.formHost.set(d.host ?? '');
    this.formPort.set(d.port);
    this.formUnitId.set(d.unitId);
    this.formInterval.set(d.pollIntervalS);
    this.formError.set(null);
  }

  save(): void {
    this.formError.set(null);
    const editingId = this.formEditingId();
    void this.data
      .saveDeviceConfig({
        id: editingId ?? undefined,
        driver: this.driver(),
        name: this.formName().trim() || null,
        enabled: this.formEnabled(),
        host: this.formHost().trim() || null,
        port: this.isModbus() ? (this.formPort() ?? 502) : null,
        unitId: this.isModbus() ? (this.formUnitId() ?? 1) : null,
        pollIntervalS: this.formInterval() ?? (this.isModbus() ? 30 : 60),
      })
      .then((ok) => {
        if (ok) this.resetForm();
        else {
          this.formError.set(
            editingId !== null
              ? 'Gerät konnte nicht gespeichert werden.'
              : 'Gerät konnte nicht angelegt werden.',
          );
        }
      });
  }

  remove(d: DeviceConfig): void {
    this.formError.set(null);
    if (this.formEditingId() === d.id) this.resetForm();
    void this.data.deleteDeviceConfig(d.id).then((ok) => {
      if (!ok) this.formError.set('Gerät konnte nicht gelöscht werden.');
    });
  }
}
