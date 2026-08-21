import type { DeviceDriver } from '@org/shared-types';

/**
 * Emitted to create (id undefined) or update (id set) a device instance.
 * `driver` only matters on create — an update targets an existing row by id
 * and never changes what it is.
 */
export interface DeviceConfigSaveEvent {
  id?: number;
  driver: DeviceDriver;
  name: string | null;
  enabled: boolean;
  host: string | null;
  port: number | null;
  unitId: number | null;
  pollIntervalS: number;
}

/** Emitted to create (id undefined) or update (id set) a meter checkpoint. */
export interface CheckpointSaveEvent {
  id?: number;
  date: string;
  /** Local time of day the meter was read (HH:MM). */
  readAt: string;
  importKwh: number;
  exportKwh: number;
}

/** Emitted to create (id undefined) or update (id set) a tariff period. */
export interface TariffPeriodSaveEvent {
  id?: number;
  validFrom: string;
  provider: string | null;
  importCtPerKwh: number | null;
  exportCtPerKwh: number | null;
  baseEurPerYear: number | null;
}

/** Top-level sections of the admin page. */
export type AdminSection = 'config' | 'devices' | 'tariffs' | 'checkpoints' | 'system';
