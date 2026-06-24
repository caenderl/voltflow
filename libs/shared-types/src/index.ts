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

/** Available data range (first/last reading), for period navigation. */
export interface DataRange {
  first: string | null;
  last: string | null;
}

/** Name of the WebSocket event used to push live readings. */
export const METER_READING_EVENT = 'reading';
