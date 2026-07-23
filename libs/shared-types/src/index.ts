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

/**
 * App-wide display preferences (single row, id = 1). Separate from the tariff
 * because calibration corrects the raw kWh shown everywhere, not just the
 * tariff-derived costs — it applies even with no prices set.
 */
export interface AppSettings {
  /**
   * Show grid import/export (and the costs derived from them) corrected onto the
   * physical meter, using the checkpoint reconciliation's factors. Off by
   * default; has no visible effect until at least one comparable checkpoint pair
   * exists to derive a factor from.
   */
  calibrationEnabled: boolean;
}

/**
 * Electricity tariff (work prices) valid from a date. A period applies from its
 * `validFrom` until the next period begins; the oldest period extends backward
 * to cover all earlier data. Costs are derived from kWh × the applicable price.
 */
export interface TariffPeriod {
  id: number;
  /** Local date this tariff takes effect (YYYY-MM-DD). Unique across periods. */
  validFrom: string;
  provider: string | null;
  /** Consumption price in ct/kWh. */
  importCtPerKwh: number | null;
  /** Feed-in price in ct/kWh. */
  exportCtPerKwh: number | null;
}

/** Payload to create/update a tariff period. */
export interface TariffPeriodInput {
  validFrom: string;
  provider: string | null;
  importCtPerKwh: number | null;
  exportCtPerKwh: number | null;
}

/** Available data range (first/last reading), for period navigation. */
export interface DataRange {
  first: string | null;
  last: string | null;
}

/**
 * Manually entered meter checkpoint (Zählerstand), used to validate the smart
 * meter's cumulative readings against the physical meter from time to time.
 */
export interface MeterCheckpoint {
  id: number;
  /** Local date the reading was taken (YYYY-MM-DD). */
  date: string;
  /**
   * Local time of day the reading was taken (HH:MM). Required — the smart
   * meter counterpart is looked up at exactly this moment, so there is no
   * assumed reading time to fall back on.
   */
  readAt: string;
  /** Cumulative import (Bezug) meter reading in kWh. */
  importKwh: number;
  /** Cumulative export (Einspeisung) meter reading in kWh. */
  exportKwh: number;
  createdAt: string;
}

/** Payload to create/update a meter checkpoint. */
export interface MeterCheckpointInput {
  date: string;
  /** Local time of day the reading was taken (HH:MM). */
  readAt: string;
  importKwh: number;
  exportKwh: number;
}

/**
 * Why an interval between two checkpoints could (not) be compared.
 *
 * `ok` — both ends have a smart meter reading and both counters advanced.
 * `no-data` — the smart meter has no reading close enough to the recorded
 *   reading time on one of the two checkpoints.
 * `reset` — a counter jumped backwards (device swap, reset, typo in the entry).
 */
export type ReconciliationStatus = 'ok' | 'no-data' | 'reset';

/**
 * One interval between two consecutive checkpoints: what the physical meter
 * counted vs. what the smart meter counted over the same span. Both sides are
 * cumulative counters, so a collector outage inside the interval does not
 * distort the comparison.
 */
export interface ReconciliationInterval {
  /** Checkpoint dates bounding the interval (YYYY-MM-DD). */
  fromDate: string;
  toDate: string;
  /**
   * Reading times of the two bounding checkpoints (HH:MM) — the exact moments
   * the smart meter was sampled at. Shown alongside the dates so a deviation
   * can be judged against the span it was actually measured over.
   */
  fromReadAt: string;
  toReadAt: string;
  /** Length of the interval in whole days; the reading times are not counted. */
  days: number;
  /** Physical meter deltas over the interval in kWh — the ground truth. */
  meterImportKwh: number;
  meterExportKwh: number;
  /** Smart meter deltas over the same interval in kWh; null without data. */
  smartImportKwh: number | null;
  smartExportKwh: number | null;
  /** Smart minus physical in kWh (negative = the smart meter undercounts). */
  importDeviationKwh: number | null;
  exportDeviationKwh: number | null;
  /** Deviation relative to the physical delta, in percent (1.5 = 1.5 %). */
  importDeviationPct: number | null;
  exportDeviationPct: number | null;
  status: ReconciliationStatus;
}

/**
 * All comparable intervals combined — the basis for the correction factors.
 *
 * Deliberately carries no from/to date: the comparable intervals need not be
 * contiguous (a single unreadable checkpoint knocks out the two intervals
 * around it), so an outer date range would imply a continuous measurement that
 * the kWh sums do not cover. `days` therefore counts only the measured days,
 * and `skippedCount` says how much was left out.
 */
export interface ReconciliationTotals {
  /** Days actually covered by the comparable intervals, excluding gaps. */
  days: number;
  /** How many intervals went into these totals. */
  intervalCount: number;
  /** Intervals left out because they were not comparable (no-data / reset). */
  skippedCount: number;
  meterImportKwh: number;
  meterExportKwh: number;
  smartImportKwh: number;
  smartExportKwh: number;
  importDeviationKwh: number;
  exportDeviationKwh: number;
  importDeviationPct: number | null;
  exportDeviationPct: number | null;
  /** physical / smart — multiply a smart meter delta by this to calibrate it. */
  importFactor: number | null;
  exportFactor: number | null;
}

/**
 * The physical meter reading extrapolated to now: the latest usable checkpoint
 * plus everything the smart meter has counted since.
 */
export interface MeterProjection {
  /** Checkpoint the projection starts from (YYYY-MM-DD). */
  baseDate: string;
  /** Time of the smart meter reading the projection ends at. */
  asOf: string;
  /** Smart meter deltas since the base checkpoint in kWh. */
  sinceImportKwh: number;
  sinceExportKwh: number;
  /** Projected current physical meter readings in kWh. */
  importKwh: number;
  exportKwh: number;
  /** Same with the learned correction factor applied; null without a factor. */
  calibratedImportKwh: number | null;
  calibratedExportKwh: number | null;
}

/** Response of GET /api/meter-checkpoints/reconciliation. */
export interface MeterReconciliation {
  intervals: ReconciliationInterval[];
  totals: ReconciliationTotals | null;
  projection: MeterProjection | null;
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

/** Hourly charging energy summary, returned by GET /api/wallbox/energy/hourly. */
export interface WallboxHourlySummary {
  /** ISO timestamp of the hour bucket start. */
  time: string;
  /** Energy charged this hour in kWh. */
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

/** Per-minute average PV power, returned by GET /api/sma/power/minute. */
export interface SmaMinutePower {
  /** ISO timestamp of the minute bucket start. */
  time: string;
  /** Average PV power (grid_power) this minute, in W. */
  powerW: number;
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

// ---------------------------------------------------------------------------
// System health (host monitoring for the admin "System" tab)
// ---------------------------------------------------------------------------

/** Host load average over 1/5/15 min, with CPU core count for normalization. */
export interface SystemLoad {
  avg1: number;
  avg5: number;
  avg15: number;
  /** Number of logical CPU cores (load == cores means ~100% utilization). */
  cores: number;
}

/** Host memory usage in bytes (used = total − available). */
export interface SystemMemory {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

/** Filesystem usage in bytes for the disk backing the app/data. */
export interface SystemDisk {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

/** One running (or stopped) Docker container of the stack. */
export interface ContainerStatus {
  /** Container name (leading slash stripped). */
  name: string;
  /** Image reference. */
  image: string;
  /** Short state: running | exited | restarting | paused | … */
  state: string;
  /** Human status line, e.g. "Up 3 hours" or "Exited (0) 2 minutes ago". */
  status: string;
}

/**
 * Point-in-time host health snapshot, returned by GET /api/system/health.
 * Not persisted — the frontend polls this and keeps a short rolling window.
 */
export interface SystemHealth {
  /** ISO timestamp the snapshot was taken. */
  time: string;
  /** Host uptime in seconds. */
  uptimeSec: number;
  load: SystemLoad;
  memory: SystemMemory;
  /** Null when disk stats are unavailable (e.g. statfs failed). */
  disk: SystemDisk | null;
  /** Empty when the Docker socket is unavailable/unreadable. */
  containers: ContainerStatus[];
}
