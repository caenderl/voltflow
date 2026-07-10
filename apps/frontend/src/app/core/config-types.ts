import type { SmaConfig, Tariff, WallboxConfig } from '@org/shared-types';

/** Emitted by the admin page to persist the tariff + device configs together. */
export interface ConfigSaveEvent {
  tariff: Tariff;
  wallbox: WallboxConfig;
  sma: SmaConfig;
}

/** Emitted to create (id undefined) or update (id set) a meter checkpoint. */
export interface CheckpointSaveEvent {
  id?: number;
  date: string;
  importKwh: number;
  exportKwh: number;
}

/** Top-level sections of the admin page. */
export type AdminSection = 'config' | 'checkpoints' | 'system';
