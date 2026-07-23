import type {
  MeterProjection,
  MeterReconciliation,
  ReconciliationInterval,
  ReconciliationStatus,
  ReconciliationTotals,
} from '@org/shared-types';
import { round2, round4 } from '../common/db-utils';

/** A checkpoint plus the smart meter counters at the moment it was read. */
export interface CheckpointSample {
  /** Local date of the checkpoint (YYYY-MM-DD). */
  date: string;
  /** Local time of day the meter was read (HH:MM). */
  readAt: string;
  /** Physical meter readings as entered by hand. */
  importKwh: number;
  exportKwh: number;
  /**
   * Smart meter counters as of the reading time; null when the smart meter has
   * no value close enough to it.
   */
  counterImportKwh: number | null;
  counterExportKwh: number | null;
}

/** The smart meter's current cumulative counters. */
export interface CounterSnapshot {
  /** ISO timestamp of the reading. */
  time: string;
  importKwh: number;
  exportKwh: number;
}

/** A sample that actually carries smart meter counters. */
type ComparableSample = CheckpointSample & {
  counterImportKwh: number;
  counterExportKwh: number;
};

/**
 * Reconcile the hand-read physical meter against the smart meter — pure
 * arithmetic, no DB.
 *
 * Both sides are cumulative counters with different zero points, so they are
 * compared as deltas between consecutive checkpoints. That makes the comparison
 * immune to collector downtime: the smart meter keeps counting internally, only
 * the distribution *within* an interval would have gaps.
 *
 * `samples` must be ordered by date ascending. The projection extrapolates the
 * physical reading to `now` from the most recent usable checkpoint.
 */
export function computeReconciliation(
  samples: CheckpointSample[],
  now: CounterSnapshot | null,
): MeterReconciliation {
  const intervals: ReconciliationInterval[] = [];
  for (let i = 1; i < samples.length; i++) {
    intervals.push(compareInterval(samples[i - 1], samples[i]));
  }

  const totals = sumComparable(intervals);
  return {
    intervals,
    totals,
    projection: project(samples, now, totals),
  };
}

/** Compare one pair of consecutive checkpoints. */
function compareInterval(
  prev: CheckpointSample,
  cur: CheckpointSample,
): ReconciliationInterval {
  const meterImport = cur.importKwh - prev.importKwh;
  const meterExport = cur.exportKwh - prev.exportKwh;

  const base: ReconciliationInterval = {
    fromDate: prev.date,
    toDate: cur.date,
    fromReadAt: prev.readAt,
    toReadAt: cur.readAt,
    days: daysBetween(prev.date, cur.date),
    meterImportKwh: round2(meterImport),
    meterExportKwh: round2(meterExport),
    smartImportKwh: null,
    smartExportKwh: null,
    importDeviationKwh: null,
    exportDeviationKwh: null,
    importDeviationPct: null,
    exportDeviationPct: null,
    status: 'no-data',
  };

  if (!isComparable(prev) || !isComparable(cur)) return base;

  const smartImport = cur.counterImportKwh - prev.counterImportKwh;
  const smartExport = cur.counterExportKwh - prev.counterExportKwh;

  // A backwards jump on either side means the counters are not the same series
  // anymore. Keep the raw deltas visible, but refuse to derive a deviation.
  const reset =
    smartImport < 0 || smartExport < 0 || meterImport < 0 || meterExport < 0;
  const status: ReconciliationStatus = reset ? 'reset' : 'ok';

  return {
    ...base,
    smartImportKwh: round2(smartImport),
    smartExportKwh: round2(smartExport),
    importDeviationKwh: reset ? null : round2(smartImport - meterImport),
    exportDeviationKwh: reset ? null : round2(smartExport - meterExport),
    importDeviationPct: reset ? null : percentDeviation(smartImport, meterImport),
    exportDeviationPct: reset ? null : percentDeviation(smartExport, meterExport),
    status,
  };
}

/** Combine every comparable interval into one deviation + correction factor. */
function sumComparable(
  intervals: ReconciliationInterval[],
): ReconciliationTotals | null {
  const ok = intervals.filter((i) => i.status === 'ok');
  if (!ok.length) return null;

  const meterImport = sum(ok.map((i) => i.meterImportKwh));
  const meterExport = sum(ok.map((i) => i.meterExportKwh));
  const smartImport = sum(ok.map((i) => i.smartImportKwh ?? 0));
  const smartExport = sum(ok.map((i) => i.smartExportKwh ?? 0));

  return {
    // Only the measured days, so the figure stays consistent with the kWh sums
    // it is shown next to. The comparable intervals need not be contiguous, so
    // spanning the outer date range instead would claim evidence for days that
    // never entered the sums.
    days: sum(ok.map((i) => i.days)),
    intervalCount: ok.length,
    skippedCount: intervals.length - ok.length,
    meterImportKwh: round2(meterImport),
    meterExportKwh: round2(meterExport),
    smartImportKwh: round2(smartImport),
    smartExportKwh: round2(smartExport),
    importDeviationKwh: round2(smartImport - meterImport),
    exportDeviationKwh: round2(smartExport - meterExport),
    importDeviationPct: percentDeviation(smartImport, meterImport),
    exportDeviationPct: percentDeviation(smartExport, meterExport),
    importFactor: smartImport > 0 ? round4(meterImport / smartImport) : null,
    exportFactor: smartExport > 0 ? round4(meterExport / smartExport) : null,
  };
}

/**
 * Extrapolate today's physical reading: the newest checkpoint that has a smart
 * meter counter, plus what the smart meter has counted since.
 */
function project(
  samples: CheckpointSample[],
  now: CounterSnapshot | null,
  totals: ReconciliationTotals | null,
): MeterProjection | null {
  if (!now) return null;

  const base = [...samples].reverse().find(isComparable);
  if (!base) return null;

  const sinceImport = now.importKwh - base.counterImportKwh;
  const sinceExport = now.exportKwh - base.counterExportKwh;
  // Backwards means the counter was reset since the checkpoint — extrapolating
  // across that would produce a reading that never existed.
  if (sinceImport < 0 || sinceExport < 0) return null;

  const importFactor = totals?.importFactor ?? null;
  const exportFactor = totals?.exportFactor ?? null;

  return {
    baseDate: base.date,
    asOf: now.time,
    sinceImportKwh: round2(sinceImport),
    sinceExportKwh: round2(sinceExport),
    importKwh: round2(base.importKwh + sinceImport),
    exportKwh: round2(base.exportKwh + sinceExport),
    calibratedImportKwh:
      importFactor === null
        ? null
        : round2(base.importKwh + sinceImport * importFactor),
    calibratedExportKwh:
      exportFactor === null
        ? null
        : round2(base.exportKwh + sinceExport * exportFactor),
  };
}

function isComparable(s: CheckpointSample): s is ComparableSample {
  return s.counterImportKwh !== null && s.counterExportKwh !== null;
}

/** Deviation of `actual` from `reference` in percent; null when undefined. */
function percentDeviation(actual: number, reference: number): number | null {
  return reference > 0 ? round2(((actual - reference) / reference) * 100) : null;
}

/** Whole days between two YYYY-MM-DD dates (UTC math: no DST offsets). */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
