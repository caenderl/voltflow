// Shared types between backend (NestJS) and frontend (Angular).
// Single source of truth for the API / WebSocket contracts.

/** A live / raw reading from the smart meter. */
export interface MeterReading {
  /** ISO timestamp of the measurement (ingestion time). */
  time: string;
  deviceSn: string;
  /** Grid import in W. */
  gridToHomePower: number | null;
  /** Feed-in / surplus in W. */
  pvToGridPower: number | null;
  /** Cumulative import meter reading in kWh. */
  gridImportEnergy: number | null;
  /** Cumulative export meter reading in kWh. */
  gridExportEnergy: number | null;
}

/** Resolution of a time series; determines the aggregate source in the backend. */
export type SeriesResolution = 'raw' | '1min' | '1hour' | '1day';

/** A single aggregated point of a power time series. */
export interface SeriesPoint {
  /** ISO timestamp of the bucket (or of the measurement when resolution=raw). */
  time: string;
  gridToHomePowerAvg: number | null;
  gridToHomePowerMax: number | null;
  pvToGridPowerAvg: number | null;
  pvToGridPowerMax: number | null;
}

/** Response of GET /api/meter/series. */
export interface SeriesResponse {
  resolution: SeriesResolution;
  from: string;
  to: string;
  points: SeriesPoint[];
}

/** Period for the energy summary. */
export type EnergyPeriod = 'day' | 'week' | 'month';

/** A single bucket of the energy summary (e.g. one day within a month). */
export interface EnergyBucket {
  /** ISO timestamp of the bucket start. */
  time: string;
  /** Import in this bucket in kWh (delta of the meter readings). */
  importKwh: number;
  /** Feed-in in this bucket in kWh (delta of the meter readings). */
  exportKwh: number;
}

/** Response of GET /api/meter/energy. */
export interface EnergySummary {
  period: EnergyPeriod;
  from: string;
  to: string;
  /** Total import over the range in kWh. */
  importKwh: number;
  /** Total feed-in over the range in kWh. */
  exportKwh: number;
  buckets: EnergyBucket[];
}

/** Electricity tariff (work prices). Costs are derived from kWh × price. */
export interface Tariff {
  provider: string | null;
  /** Consumption price in ct/kWh. */
  importCtPerKwh: number | null;
  /** Feed-in price in ct/kWh. */
  exportCtPerKwh: number | null;
}

/** Available data range (first/last reading), for period navigation. */
export interface DataRange {
  first: string | null;
  last: string | null;
}

/** Name of the WebSocket event used to push live readings. */
export const METER_READING_EVENT = 'reading';

// ---------------------------------------------------------------------------
// Wallbox (Anker SOLIX V1 / A5191, Modbus TCP)
// ---------------------------------------------------------------------------

/**
 * Connection parameters for the wallbox, stored as a single config row and
 * edited via the settings UI. The collector only polls the wallbox when this
 * is `enabled` and a `host` is set.
 */
export interface WallboxConfig {
  enabled: boolean;
  /** IP / hostname of the wallbox on the LAN (Modbus TCP). */
  host: string | null;
  /** Modbus TCP port (default 502). */
  port: number;
  /** Modbus unit / device id (default 1). */
  unitId: number;
  /** Polling interval in seconds. */
  pollIntervalS: number;
}

/** Charging status (Anker register 20097). */
export type WallboxStatus =
  | 0 // Idle
  | 1 // Preparing
  | 2 // Charging
  | 3 // Charger Paused
  | 4 // Vehicle Paused
  | 5 // Charging Completed
  | 6 // Reserving
  | 7 // Disabled
  | 8; // Error

/** Human labels for the charging status codes. */
export const WALLBOX_STATUS_LABELS: Record<number, string> = {
  0: 'Bereit',
  1: 'Vorbereiten',
  2: 'Lädt',
  3: 'Pausiert (Ladestation)',
  4: 'Pausiert (Fahrzeug)',
  5: 'Abgeschlossen',
  6: 'Reserviert',
  7: 'Deaktiviert',
  8: 'Fehler',
};

/** A live / raw reading from the wallbox. */
export interface WallboxReading {
  /** ISO timestamp of the measurement (ingestion time). */
  time: string;
  deviceSn: string;
  /** Charging status code (see WallboxStatus / WALLBOX_STATUS_LABELS). */
  status: number | null;
  /** CP signal state (register 20092; 0 = no vehicle). */
  cpSignal: number | null;
  /** Total charging active power in W. */
  activePowerW: number | null;
  /** Energy of the current charging session in Wh. */
  sessionEnergyWh: number | null;
  /** Duration of the current charging session in s. */
  sessionDurationS: number | null;
  l1CurrentA: number | null;
  l2CurrentA: number | null;
  l3CurrentA: number | null;
  l1VoltageV: number | null;
  l2VoltageV: number | null;
  l3VoltageV: number | null;
}

/** Name of the WebSocket event used to push live wallbox readings. */
export const WALLBOX_READING_EVENT = 'wallbox-reading';
