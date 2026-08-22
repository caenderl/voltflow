import { Injectable, computed, inject, signal } from '@angular/core';
import { catchError, firstValueFrom, map, of } from 'rxjs';
import {
  DRIVER_TRAITS,
  type DeviceConfig,
  type DeviceDriver,
  type DeviceInfo,
  type DeviceRole,
} from '@org/shared-types';
import type { DeviceConfigSaveEvent } from './config-types';
import { DeviceConfigApiService } from './device-config-api.service';
import { DevicesApiService } from './devices-api.service';

/**
 * A configured device instance together with what was actually found at its
 * address. `config` is what the user asked for, `info` is what answered — they
 * meet at `config.deviceSn`, which stays null until first contact.
 */
export interface DeviceInstance {
  config: DeviceConfig;
  /** Registry entry, or null while the row has never made contact. */
  info: DeviceInfo | null;
  /**
   * Best available display name: the given name, else the device's own alias,
   * else the driver's label qualified by the address. The address matters —
   * two unnamed wallboxes would otherwise both be called "Wallbox", which is
   * exactly the ambiguity per-instance views exist to remove.
   */
  name: string;
  /** Roles the domain reads this device through; empty while unbound. */
  roles: DeviceRole[];
}

/**
 * The device state of the whole app: what is configured, what has been seen,
 * and how the two line up.
 *
 * Owns this rather than `DashboardDataService` because it is not dashboard
 * state — the settings UI, the live view and (in time) the history views all
 * ask the same questions of it, and it is the one place that knows a config row
 * and a registry entry are two halves of one device.
 */
@Injectable({ providedIn: 'root' })
export class DeviceRegistryService {
  private readonly configApi = inject(DeviceConfigApiService);
  private readonly devicesApi = inject(DevicesApiService);

  /** Configured instances, as stored (`GET /api/device-configs`). */
  readonly configs = signal<DeviceConfig[]>([]);
  /** Every device ever registered by a collector (`GET /api/devices`). */
  readonly devices = signal<DeviceInfo[]>([]);

  private readonly bySerial = computed(
    () => new Map(this.devices().map((d) => [d.deviceSn, d])),
  );

  /** Every configured instance, joined to the device found at it. */
  readonly instances = computed<DeviceInstance[]>(() =>
    this.configs().map((config) => {
      const info = config.deviceSn
        ? (this.bySerial().get(config.deviceSn) ?? null)
        : null;
      const label = DRIVER_TRAITS[config.driver].label;
      return {
        config,
        info,
        name:
          config.name?.trim() ||
          info?.alias?.trim() ||
          (config.host ? `${label} ${config.host}` : label),
        roles: info?.roles ?? [],
      };
    }),
  );

  /** The configured instances of one driver, in stored order. */
  instancesOf(driver: DeviceDriver): DeviceInstance[] {
    return this.instances().filter((i) => i.config.driver === driver);
  }

  /**
   * Is any instance of this driver enabled?
   *
   * What the site-level views gate on. They show one figure for the whole house
   * (total PV yield, total charged energy), so the question is whether such a
   * device exists at all — not which one, which is why nothing here picks a
   * representative row any more.
   */
  hasEnabled(driver: DeviceDriver): boolean {
    return this.configs().some((c) => c.driver === driver && c.enabled);
  }

  /** Load both halves. Errors are ignored — the app renders without them. */
  load(): void {
    this.configApi.list().subscribe({
      next: (c) => this.configs.set(c),
      error: () => undefined,
    });
    this.loadDevices();
  }

  private loadDevices(): void {
    this.devicesApi.list().subscribe({
      next: (d) => this.devices.set(d),
      error: () => undefined,
    });
  }

  /**
   * Create (no id) or update (id set) an instance. Resolves true only once the
   * save has landed, so a caller can keep its form until then.
   *
   * Deliberately exposes no shared error signal: the settings page shows one
   * list per driver at once, and a single message would surface under whichever
   * card rendered rather than the one that failed.
   */
  save(event: DeviceConfigSaveEvent): Promise<boolean> {
    const input = {
      name: event.name,
      enabled: event.enabled,
      host: event.host,
      port: event.port,
      unitId: event.unitId,
      pollIntervalS: event.pollIntervalS,
    };
    const obs =
      event.id === undefined
        ? this.configApi.create({ driver: event.driver, ...input })
        : this.configApi.update(event.id, input);
    return firstValueFrom(
      obs.pipe(
        map(() => {
          this.load();
          return true;
        }),
        catchError(() => of(false)),
      ),
    );
  }

  /**
   * Change what a device is in energy terms. Every role view filters on this,
   * so a correction here moves the device into (or out of) the house load, the
   * statistics and the energy balance from the next query onwards - no
   * migration, no restart.
   */
  setRoles(deviceSn: string, roles: DeviceRole[]): Promise<boolean> {
    return firstValueFrom(
      this.devicesApi.setRoles(deviceSn, roles).pipe(
        map((updated) => {
          this.devices.set(
            this.devices().map((d) => (d.deviceSn === updated.deviceSn ? updated : d)),
          );
          return true;
        }),
        catchError(() => of(false)),
      ),
    );
  }

  /** Same non-shared-error reasoning as {@link save}. */
  remove(id: number): Promise<boolean> {
    return firstValueFrom(
      this.configApi.delete(id).pipe(
        map(() => {
          // Drop the row locally, but refetch the registry: the device itself
          // is deliberately NOT deleted, so it stays in the registry list as
          // "nicht konfiguriert" rather than disappearing.
          this.configs.set(this.configs().filter((c) => c.id !== id));
          this.loadDevices();
          return true;
        }),
        catchError(() => of(false)),
      ),
    );
  }
}
