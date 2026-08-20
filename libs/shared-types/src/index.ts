// Shared types between backend (NestJS) and frontend (Angular).
// Single source of truth for the API / WebSocket contracts.

/**
 * What a device does in the energy balance — independent of who built it and
 * of the protocol it is read with. The domain (house load, balance, statistics)
 * only ever needs this, never the vendor.
 *
 * A device carries a *set* of roles, not one: a hybrid inverter produces and
 * stores, a bidirectional wallbox consumes and produces.
 */
export type DeviceRole = 'grid-meter' | 'producer' | 'consumer' | 'storage';

/** A device as the registry knows it (GET /api/devices). */
export interface DeviceInfo {
  /** Serial number — the identity every reading is tagged with. */
  deviceSn: string;
  /** Model / part number as reported by the device, when it reports one. */
  devicePn: string | null;
  /**
   * Which collector registered it (`smartmeter` | `inverter` | `wallbox`).
   * A driver fact, kept for diagnostics — prefer {@link roles} for anything
   * that reasons about energy.
   */
  type: string | null;
  alias: string | null;
  roles: DeviceRole[];
  /** When the device was first seen, ISO timestamp. */
  firstSeen: string;
}

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
  /**
   * Standing charge (Grundpreis) in €/year. Charged pro rata by days and only
   * by the billing statement — the day/week/month costs are consumption costs,
   * where a daily share of a standing fee would be noise.
   */
  baseEurPerYear: number | null;
}

/** Payload to create/update a tariff period. */
export interface TariffPeriodInput {
  validFrom: string;
  provider: string | null;
  importCtPerKwh: number | null;
  exportCtPerKwh: number | null;
  baseEurPerYear: number | null;
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
  /**
   * The smart meter delta rests on a counter more than an hour off one of the
   * two reading times (a data gap forced a fallback within the lookup window),
   * so it is only approximate. Only meaningful when `status` is `ok`/`reset`.
   */
  approximate: boolean;
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
  /** Of `intervalCount`, how many rest on a stale (fallback) SmartMeter counter. */
  approximateCount: number;
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

// ---------------------------------------------------------------------------
// Billing statement (Abrechnung) — costs anchored on the hand-read meter
// ---------------------------------------------------------------------------

/**
 * Where a month's kWh come from.
 *
 * `measured` — inside the checkpointed range: the kWh are a share of a physical
 *   meter delta that is known exactly, the smart meter only says how that delta
 *   distributes over the days.
 * `estimated` — outside it (before the first reading or after the last): the
 *   smart meter's own kWh, scaled by the deviation factor learned from the
 *   measured intervals.
 */
export type BillingSource = 'measured' | 'estimated';

/** One month of the statement. All money in €, all energy in kWh. */
export interface BillingMonth {
  /** First day of the month (YYYY-MM-DD) — also the row's identity. */
  month: string;
  importKwh: number;
  exportKwh: number;
  importCost: number;
  exportRevenue: number;
  /** Share of the annual standing charge falling on this month. */
  baseFee: number;
  /**
   * importCost + baseFee — what the consumption contract costs for the month.
   * Deliberately not netted against `exportRevenue`: consumption and feed-in are
   * two separate contracts, and a single figure spanning both answers no
   * question either of them asks.
   */
  importTotal: number;
  /**
   * False when no data covers the month at all (a future month, or before the
   * meter existed) — the UI shows "–" rather than a 0 that looks measured.
   */
  hasData: boolean;
  /**
   * Fraction of the month's energy (import + feed-in) that is `measured` (0–1).
   * 1 means every kWh is anchored on a pair of hand-read stands; 0 means the
   * month rests entirely on the smart meter. Anything in between is a month
   * whose seams reach into an unanchored stretch.
   */
  measuredShare: number;
  /** Hand-read checkpoints falling inside this month — what anchors it. */
  readings: number;
}

/**
 * One reading interval touching the year: what the physical meter counted
 * between two hand-read stands. Reported in full even when it reaches beyond the
 * year, because this is the evidence the months rest on — clipping it here would
 * hide the very number that was read off the meter.
 */
export interface BillingPeriod {
  fromDate: string;
  toDate: string;
  fromReadAt: string;
  toReadAt: string;
  days: number;
  /** Exact physical deltas over the interval. */
  importKwh: number;
  exportKwh: number;
  /** Average import per day, for judging one interval against another. */
  importPerDay: number;
  /** The interval lies entirely within the statement year. */
  withinYear: boolean;
}

/** The year's bottom line. Sums of the rounded months, so the columns add up. */
export interface BillingTotals {
  importKwh: number;
  exportKwh: number;
  importCost: number;
  exportRevenue: number;
  baseFee: number;
  /** importCost + baseFee, summed from the rounded months. */
  importTotal: number;
  /** Fraction of the year's energy (import + feed-in) that is `measured` (0–1). */
  measuredShare: number;
}

/** Response of GET /api/billing?year=YYYY. */
export interface BillingStatement {
  /** Calendar year the statement covers. */
  year: number;
  months: BillingMonth[];
  periods: BillingPeriod[];
  totals: BillingTotals;
  /**
   * Deviation factors (physical / smart) learned from every checkpointed
   * interval in the data, used to scale the `estimated` stretches. Null when no
   * interval is comparable — then estimated kWh are the raw smart meter values.
   */
  importFactor: number | null;
  exportFactor: number | null;
  /** Hand-read checkpoints that fall inside this year. */
  readings: number;
  /** No tariff with prices covers the year — the UI then shows kWh only. */
  priced: boolean;
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
  /**
   * Energy charged since the PREVIOUS reading in Wh, integrated by the
   * collector over the actual elapsed time between polls. Prefer this over
   * re-deriving energy from activePowerW and an assumed sample spacing: the
   * poll interval is user-configurable and changing it would otherwise
   * retroactively rescale every historical reading. Null only for rows written
   * before the column existed.
   */
  energyWh: number | null;
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

// ---------------------------------------------------------------------------
// Backups (admin "System" tab)
// ---------------------------------------------------------------------------

/** One rotated on-host database dump written by scripts/backup.sh. */
export interface BackupDump {
  /** File name, e.g. "voltflow-20260731-030001.sql.gz". */
  file: string;
  /**
   * ISO timestamp the dump was written. Taken from the file's mtime, not from
   * the name: the name carries the *host's* local time with no offset, which a
   * container running in UTC would misread by the DST offset.
   */
  time: string;
  sizeBytes: number;
}

/** The on-host dump tier (scripts/backup.sh + its KEEP rotation). */
export interface LocalBackups {
  /** Directory the dumps were read from (as seen by the backend). */
  dir: string;
  /** Dumps oldest first. */
  dumps: BackupDump[];
  /** Bytes all dumps occupy together. */
  totalBytes: number;
}

/** One restic snapshot in the off-site repository. */
export interface OffsiteSnapshot {
  /** restic short id, e.g. "9dbe0ad6". */
  id: string;
  time: string;
  /** First tag: "db" (the SQL dump) or "config" (.env + certs). */
  tag: string;
  /** Bytes restic read for this snapshot (the uncompressed dump). */
  sizeBytes: number;
  /** Bytes actually stored after dedup + compression. Null if unknown. */
  addedBytes: number | null;
  /** How long the snapshot took, in seconds. Null if unknown. */
  durationSec: number | null;
}

/** GFS retention as configured in scripts/backup.env. */
export interface OffsiteRetention {
  daily: number;
  weekly: number;
  monthly: number;
}

/**
 * Status of the off-site restic repository, written as `status.json` by
 * scripts/backup-offsite.sh at the end of every run (success *and* failure).
 * The backend only reads that file — it has neither restic nor the repo
 * credentials, and a live query would go over the network to the cloud repo.
 */
export interface OffsiteStatus {
  /** ISO timestamp of the run that produced this status. */
  time: string;
  /** False when the run aborted (backup, retention or check failed). */
  ok: boolean;
  /** Stage the run failed in, e.g. "backup" / "check". Null when ok. */
  failedStage: string | null;
  /** Verdict of the `restic check` that ran last. Null if it never got there. */
  checkOk: boolean | null;
  /** Repository location, e.g. "rclone:gdrive:voltflow-backups". */
  repository: string;
  /** Total repo size in bytes (restic stats). Null when unavailable. */
  repoSizeBytes: number | null;
  /** Snapshots in the repo across all tags. Null when unavailable. */
  snapshotCount: number | null;
  retention: OffsiteRetention | null;
  /** The newest snapshot per tag plus recent history, oldest first. */
  snapshots: OffsiteSnapshot[];
}

/**
 * Both backup tiers, returned by GET /api/system/backups. Each tier is null
 * when its source is unavailable (backup dir not mounted / off-site never ran),
 * so a missing tier never fails the whole response.
 */
export interface BackupStatus {
  /** ISO timestamp the snapshot was assembled. */
  time: string;
  local: LocalBackups | null;
  offsite: OffsiteStatus | null;
}

// ---------------------------------------------------------------------------
// Statistics (GET /api/statistics) — all-time records over the stored data
// ---------------------------------------------------------------------------

/** A power record: the highest value seen, and when it was measured. */
export interface StatPeak {
  /** ISO timestamp of the bucket the peak was measured in. */
  time: string;
  powerW: number;
}

/** An energy record: the strongest local day and its kWh. */
export interface StatDayRecord {
  /** Local day, YYYY-MM-DD. */
  day: string;
  kwh: number;
}

/** PV records. Null fields mean the data does not (yet) support the figure. */
export interface PvStatistics {
  /** Highest instantaneous production, over the whole daily aggregate. */
  peak: StatPeak | null;
  /** Best day's yield, over the fully covered days. */
  bestDay: StatDayRecord | null;
  /** Mean yield of the fully covered days, kWh. */
  avgDayKwh: number | null;
}

/** House-consumption records (PV + grid import − feed-in). */
export interface ConsumptionStatistics {
  /**
   * Highest house load on the 1-minute grid. Limited to the retention of the
   * minute aggregate (see {@link StatisticsResponse.peakWindowDays}) — the
   * long-term aggregates only keep hourly averages, which are no peak.
   */
  peak: StatPeak | null;
  /** Highest daily consumption, over the fully covered days. */
  maxDay: StatDayRecord | null;
  /** Mean consumption of the fully covered days, kWh. */
  avgDayKwh: number | null;
}

/**
 * The house's base load: what it draws at night with nothing switched on.
 * Measured per night as a low percentile of the house load between midnight and
 * 05:00 local, with the wallbox's own power subtracted — a charging car is not
 * standby, and it would otherwise dominate the figure.
 */
export interface StandbyStatistics {
  /** Mean of the nightly base loads, W. */
  avgW: number | null;
  /** Quietest / busiest night's base load, W. */
  minW: number | null;
  maxW: number | null;
  /** Nights that went into the average. */
  nights: number;
  /** avgW held for 24 h. */
  perDayKwh: number | null;
  /** …and for a year (365 days). */
  perYearKwh: number | null;
  /** Share of the average day's consumption that is base load (0..1). */
  shareOfConsumption: number | null;
}

/** One simulated storage size and what it would have achieved. */
export interface StorageSizingPoint {
  capacityKwh: number;
  /** Share of consumption covered without the grid (0..1). */
  autarky: number;
  /** Share of PV production used at home instead of fed in (0..1). */
  selfConsumption: number;
}

/**
 * Storage sizing, simulated hour by hour over every fully covered day: grid
 * import is served from the store first, feed-in charges it (losses applied on
 * the way in), and what it cannot cover stays grid import.
 *
 * This describes a *hypothetical* store ("how big would one have to be"), not
 * an installed one - hence StorageSizing rather than Storage/Battery, which
 * stay free for a device that actually exists.
 */
export interface StorageSizing {
  /** Autarky actually measured, i.e. the curve's 0 kWh point (0..1). */
  baseAutarky: number | null;
  /** Autarky / self-consumption over a range of sizes, ascending. */
  curve: StorageSizingPoint[];
  /**
   * Smallest simulated size that would have removed *all* grid import over the
   * measured period. Null when no size reaches it — with too little sun the
   * energy is simply missing, and no storage can invent it.
   */
  fullAutarkyKwh: number | null;
  /** Size beyond which another kWh adds less than a point of autarky. */
  kneeKwh: number | null;
  /** Autarky at {@link kneeKwh} (0..1). */
  kneeAutarky: number | null;
  /** Typical / worst dark-hours consumption the store has to bridge, kWh. */
  medianNightKwh: number | null;
  maxNightKwh: number | null;
  /** Totals the simulation ran on, kWh. */
  productionKwh: number;
  consumptionKwh: number;
  /** Round-trip efficiency the simulation assumed (0..1). */
  efficiency: number;
}

/** Response of GET /api/statistics. */
export interface StatisticsResponse {
  /** First / last local day with complete hourly data (YYYY-MM-DD). */
  firstDay: string | null;
  lastDay: string | null;
  /** Days with complete data — the basis of every daily figure below. */
  days: number;
  /**
   * How far back the 1-minute aggregate reaches, in days. The peak *power*
   * figures cannot look further back than this; everything else spans the
   * whole history.
   */
  peakWindowDays: number;
  pv: PvStatistics;
  consumption: ConsumptionStatistics;
  standby: StandbyStatistics;
  storageSizing: StorageSizing;
}
