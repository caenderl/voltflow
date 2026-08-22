import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import {
  DEVICE_ROLES,
  DEVICE_ROLE_LABELS,
  type DeviceInfo,
  type DeviceRole,
} from '@org/shared-types';
import { DeviceRegistryService } from '../../../core/device-registry.service';
import { SettingsCardComponent } from '../../../ui/settings-card/settings-card.component';

/** A registry entry plus the configured instance that claims it, if any. */
interface RegistryRow {
  info: DeviceInfo;
  /** Name of the config row bound to this serial, or null when nothing is. */
  claimedBy: string | null;
}

/**
 * Every device a collector has ever registered, with the roles the domain reads
 * it through — and the one place those roles can be corrected.
 *
 * This closes a hole rather than adding a feature: `device.roles` decides
 * whether a device counts towards the house load, the statistics and the energy
 * balance, it was written only by the collector's first-contact guess, and it
 * was visible nowhere. A device the collector could not classify contributed
 * nothing, silently, with no way to find out.
 *
 * Deliberately lists devices the settings UI cannot otherwise reach: the smart
 * meter has no config row by design, and hardware whose row was deleted keeps
 * its readings and its roles.
 */
@Component({
  selector: 'app-device-registry-list',
  standalone: true,
  imports: [SettingsCardComponent, DatePipe],
  templateUrl: './device-registry-list.component.html',
  styleUrl: './device-registry-list.component.scss',
})
export class DeviceRegistryListComponent {
  private readonly registry = inject(DeviceRegistryService);

  readonly roles = DEVICE_ROLES;
  readonly roleLabels = DEVICE_ROLE_LABELS;
  readonly error = signal<string | null>(null);
  /** Serial currently being saved — blocks a second click on the same row. */
  readonly saving = signal<string | null>(null);

  readonly rows = computed<RegistryRow[]>(() => {
    const claims = new Map(
      this.registry
        .instances()
        .filter((i) => i.config.deviceSn)
        .map((i) => [i.config.deviceSn as string, i.name]),
    );
    return this.registry.devices().map((info) => ({
      info,
      claimedBy: claims.get(info.deviceSn) ?? null,
    }));
  });

  has(info: DeviceInfo, role: DeviceRole): boolean {
    return info.roles.includes(role);
  }

  /**
   * Toggling the last remaining role is refused here rather than sent and
   * rejected: the backend does not accept an empty set (it would not survive a
   * restart), and saying so before the request is clearer than a failed save.
   */
  toggle(info: DeviceInfo, role: DeviceRole): void {
    if (this.saving()) return;
    this.error.set(null);
    const next = this.has(info, role)
      ? info.roles.filter((r) => r !== role)
      : [...info.roles, role];
    if (!next.length) {
      this.error.set('Ein Gerät braucht mindestens eine Rolle.');
      return;
    }
    this.saving.set(info.deviceSn);
    void this.registry.setRoles(info.deviceSn, next).then((ok) => {
      this.saving.set(null);
      if (!ok) this.error.set('Rolle konnte nicht gespeichert werden.');
    });
  }
}
