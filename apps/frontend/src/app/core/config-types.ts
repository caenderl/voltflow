import type { AppSettings, SmaConfig, WallboxConfig } from '@org/shared-types';

/** Emitted by the admin page to persist the display + device configs together. */
export interface ConfigSaveEvent {
  appSettings: AppSettings;
  wallbox: WallboxConfig;
  sma: SmaConfig;
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
}

/** Top-level sections of the admin page. */
export type AdminSection = 'config' | 'tariffs' | 'checkpoints' | 'system';
