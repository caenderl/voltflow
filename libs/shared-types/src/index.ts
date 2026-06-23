// Geteilte Typen zwischen Backend (NestJS) und Frontend (Angular).
// Quelle der Wahrheit für die API-/WebSocket-Verträge.

/** Ein Live-/Roh-Messwert vom Smart Meter. */
export interface MeterReading {
  /** ISO-Zeitstempel der Messung (Ingestion-Zeit). */
  time: string;
  deviceSn: string;
  /** Netzbezug in W (Import). */
  gridToHomePower: number | null;
  /** Einspeisung in W (Überschuss). */
  pvToGridPower: number | null;
  /** Kumulativer Zählerstand Bezug in kWh. */
  gridImportEnergy: number | null;
  /** Kumulativer Zählerstand Einspeisung in kWh. */
  gridExportEnergy: number | null;
}

/** Auflösung einer Zeitreihe; bestimmt die Aggregat-Quelle im Backend. */
export type SeriesResolution = 'raw' | '1min' | '1hour' | '1day';

/** Ein aggregierter Punkt einer Leistungs-Zeitreihe. */
export interface SeriesPoint {
  /** ISO-Zeitstempel des Buckets (bzw. der Messung bei resolution=raw). */
  time: string;
  gridToHomePowerAvg: number | null;
  gridToHomePowerMax: number | null;
  pvToGridPowerAvg: number | null;
  pvToGridPowerMax: number | null;
}

/** Antwort von GET /api/meter/series. */
export interface SeriesResponse {
  resolution: SeriesResolution;
  from: string;
  to: string;
  points: SeriesPoint[];
}

/** Zeitraum für die Energie-Auswertung. */
export type EnergyPeriod = 'day' | 'week' | 'month';

/** Ein Bucket der Energie-Auswertung (z. B. ein Tag im Monat). */
export interface EnergyBucket {
  /** ISO-Zeitstempel des Bucket-Beginns. */
  time: string;
  /** Bezug in diesem Bucket in kWh (Delta der Zählerstände). */
  importKwh: number;
  /** Einspeisung in diesem Bucket in kWh (Delta der Zählerstände). */
  exportKwh: number;
}

/** Antwort von GET /api/meter/energy. */
export interface EnergySummary {
  period: EnergyPeriod;
  from: string;
  to: string;
  /** Gesamtbezug im Zeitraum in kWh. */
  importKwh: number;
  /** Gesamteinspeisung im Zeitraum in kWh. */
  exportKwh: number;
  buckets: EnergyBucket[];
}

/** Name des WebSocket-Events, über das Live-Messwerte gepusht werden. */
export const METER_READING_EVENT = 'reading';
