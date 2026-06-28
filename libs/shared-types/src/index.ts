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
  /** Display name for the wallbox (shown in the UI). */
  name: string | null;
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

/** Daily charging energy summary per day, returned by GET /api/wallbox/energy/daily. */
export interface WallboxDailySummary {
  /** Local date in ISO format (YYYY-MM-DD). */
  day: string;
  /** Total energy charged this day in kWh. */
  chargedKwh: number;
}

// ---------------------------------------------------------------------------
// SMA PV inverter (STP 6000TL-20, Speedwire via pysma-plus)
// ---------------------------------------------------------------------------

/**
 * Connection parameters for the SMA inverter, stored as a single config row
 * and edited via the settings UI. The password is NOT stored here — it is read
 * from the SMA_PASSWORD env var by the collector. The collector only polls when
 * this is `enabled` and a `host` is set.
 */
export interface SmaConfig {
  enabled: boolean;
  /** Display name for the inverter (shown in the UI). */
  name: string | null;
  /** IP / hostname of the inverter on the LAN (Speedwire). */
  host: string | null;
  /** Polling interval in seconds. */
  pollIntervalS: number;
}

/** A live / raw reading from the SMA inverter. */
export interface SmaReading {
  /** ISO timestamp of the measurement (ingestion time). */
  time: string;
  deviceSn: string;
  /** True when the inverter is asleep (night) — power fields are 0. */
  asleep: boolean;
  /** Total AC power fed to the grid connection point in W (PV production). */
  gridPower: number | null;
  /** DC power of string A / B in W. */
  pvPowerA: number | null;
  pvPowerB: number | null;
  /** Energy produced today in Wh (device counter, resets at midnight). */
  dailyYieldWh: number | null;
  /** Lifetime energy produced in kWh (device counter). */
  totalYieldKwh: number | null;
  /** AC power per phase in W. */
  powerL1: number | null;
  powerL2: number | null;
  powerL3: number | null;
  /** DC voltage / current per string. */
  pvVoltageA: number | null;
  pvVoltageB: number | null;
  pvCurrentA: number | null;
  pvCurrentB: number | null;
  /** AC voltage per phase in V. */
  voltageL1: number | null;
  voltageL2: number | null;
  voltageL3: number | null;
  /** Grid frequency in Hz. */
  frequency: number | null;
  /** Inverter temperature in °C. */
  tempA: number | null;
  /** Inverter operating status code. */
  status: number | null;
}

/** Name of the WebSocket event used to push live SMA readings. */
export const SMA_READING_EVENT = 'sma-reading';

/** Per-day energy summary, returned by the SMA energy/house-load endpoints. */
export interface SmaDailySummary {
  /** Local date in ISO format (YYYY-MM-DD). */
  day: string;
  /** PV energy produced this day in kWh. */
  yieldKwh: number;
}

/**
 * Derived energy balance over a period (kWh), combining SMA production with the
 * smart meter import/export. Enables self-consumption and self-sufficiency.
 */
export interface EnergyBalance {
  from: string;
  to: string;
  /** PV energy produced (from SMA daily_yield). */
  productionKwh: number;
  /** Grid import (from the meter). */
  importKwh: number;
  /** Grid feed-in / export (from the meter). */
  exportKwh: number;
  /** House consumption = production − export + import. */
  consumptionKwh: number;
  /** PV used directly in the house = production − export. */
  selfConsumedKwh: number;
  /** Self-consumption rate = selfConsumed / production (0..1, null if no PV). */
  selfConsumptionRate: number | null;
  /** Self-sufficiency / autarky = selfConsumed / consumption (0..1, null if no load). */
  autarkyRate: number | null;
}

/** One bucket of the derived house-load series (combined meter + SMA, 1-min grid). */
export interface HouseLoadPoint {
  time: string;
  /** Derived house consumption in W (PV + import − export). */
  housePower: number | null;
  /** PV production in W at this bucket. */
  pvPower: number | null;
}
