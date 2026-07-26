import type {
  BillingMonth,
  BillingPeriod,
  BillingStatement,
  BillingTotals,
} from '@org/shared-types';
import { round2, round4 } from '../common/db-utils';

/**
 * A hand-read checkpoint resolved to an absolute instant, so all arithmetic here
 * is timezone-free. The caller does the local-time conversion (in SQL, where the
 * timezone database lives), this module only compares instants.
 */
export interface BillingCheckpoint {
  /** Local date (YYYY-MM-DD) and time of day (HH:MM), for display. */
  date: string;
  readAt: string;
  /** The instant `date` + `readAt` denotes, in ms since the epoch. */
  at: number;
  /** Cumulative physical meter readings in kWh. */
  importKwh: number;
  exportKwh: number;
}

/**
 * One point on the smart meter's cumulative counter curve. Both aggregates store
 * `last(counter)` per bucket, so a knot is the counter value at the *end* of its
 * bucket — the caller must date it accordingly.
 */
export interface CounterKnot {
  /** Instant the counters are valid at, in ms since the epoch. */
  at: number;
  importKwh: number;
  exportKwh: number;
}

/** A tariff resolved to the instant it takes effect. */
export interface BillingTariff {
  /** Start of the tariff's local `validFrom` day, in ms since the epoch. */
  at: number;
  importCtPerKwh: number | null;
  exportCtPerKwh: number | null;
  baseEurPerYear: number | null;
}

export interface BillingInput {
  year: number;
  /**
   * 13 instants: the start of each month of `year` plus the start of the next
   * year. Supplied by the caller because month starts are local midnights, and
   * DST makes them unequally spaced.
   */
  monthStarts: number[];
  /**
   * Checkpoints ordered ascending by `at`. Must extend one checkpoint beyond the
   * year on each side where one exists, so the intervals crossing the year
   * boundary are complete — their share arithmetic needs both endpoints.
   */
  checkpoints: BillingCheckpoint[];
  /** Curve knots ordered ascending by `at`. */
  knots: CounterKnot[];
  /** Tariffs ordered ascending by `at`. */
  tariffs: BillingTariff[];
  /** Days in `year` (365 or 366) — the divisor for the annual standing charge. */
  daysInYear: number;
}

const MS_PER_DAY = 86_400_000;

/** Which of the two counters a calculation refers to. */
type Direction = 'import' | 'export';

/** Where a slice's energy comes from; `none` means no data covers it at all. */
type SliceSource = 'measured' | 'estimated' | 'none';

/** One reading interval, with the smart meter's view of the same span. */
interface Interval {
  from: BillingCheckpoint;
  to: BillingCheckpoint;
  /** Exact physical deltas over the interval. */
  meterImportKwh: number;
  meterExportKwh: number;
  /** Smart meter deltas over the same span; null when the curve does not cover it. */
  smartImportKwh: number | null;
  smartExportKwh: number | null;
  /**
   * The physical counters advanced (not a meter swap or a typo) — required to
   * bill this interval as consumption at all, independent of which direction's
   * curve data is being used.
   */
  validCounters: boolean;
}

/**
 * The instants a curve fetch must reach to cover the checkpoints bounding
 * `[from, to)` on each side, so an interval crossing either boundary has curve
 * data at both of its own endpoints instead of falling back to a pro-rata
 * split for the whole interval.
 *
 * `checkpoints` must be ordered ascending by `at` — both bounds are found by
 * first match, so an unsorted list would silently pick the wrong checkpoint.
 * The fetch itself still has to reach *past* these instants: a knot sits at its
 * bucket's end, so landing exactly on one is not enough (see BillingService).
 */
export function curveWindow(
  checkpoints: BillingCheckpoint[],
  from: number,
  to: number,
): { from: number; to: number } {
  const before = [...checkpoints].reverse().find((c) => c.at < from);
  const after = checkpoints.find((c) => c.at >= to);
  return { from: before?.at ?? from, to: after?.at ?? to };
}

/** The smallest billable unit: one tariff, one month, one reading interval. */
interface Slice {
  from: number;
  to: number;
  monthIndex: number;
  tariff: BillingTariff | undefined;
  importKwh: number;
  exportKwh: number;
  source: SliceSource;
  /**
   * Time the standing charge accrues over, in ms. The whole slice where a
   * reading interval covers it, only the part with data where it does not —
   * a month still running must not be charged a full month's base fee.
   */
  billedMs: number;
}

/**
 * Bill a calendar year against the hand-read meter — pure arithmetic, no DB.
 *
 * The physical meter is the authority on *how much* energy crossed the meter,
 * the smart meter only on *when* it did. Between two checkpoints the exact
 * physical delta is therefore distributed over time by the shape of the smart
 * meter's cumulative curve: any sub-range gets the share of the delta that the
 * curve rose over it. Two consequences make this trustworthy:
 *
 * - Only the curve's *shape* matters, never its level. A smart meter that
 *   systematically undercounts by 2 % cancels out of the share entirely.
 * - The shares of an interval sum to 1 by construction, so no energy is created
 *   or lost at a boundary — a misjudged seam only shifts kWh between the two
 *   months sharing it, and the year still adds up to the readings.
 *
 * Outside the checkpointed range (before the first reading, after the last)
 * there is no physical delta to distribute, so the smart meter's own kWh are
 * used, scaled by the deviation factor learned from every comparable interval.
 * Those stretches are reported as `estimated` and kept out of `measuredShare`.
 */
export function computeBillingStatement(input: BillingInput): BillingStatement {
  const { monthStarts, checkpoints, knots, tariffs, daysInYear, year } = input;
  const yearStart = monthStarts[0];
  const yearEnd = monthStarts[monthStarts.length - 1];

  const curve = buildCurve(knots);
  const intervals = buildIntervals(checkpoints, curve);
  const factors = {
    import: meanFactor(intervals, 'import'),
    export: meanFactor(intervals, 'export'),
  };

  const slices = sliceYear(monthStarts, checkpoints, tariffs).map((s) =>
    fillSlice(s, intervals, curve, factors),
  );

  const months = monthStarts
    .slice(0, 12)
    .map((start, i) => monthOf(year, start, i, slices, checkpoints, daysInYear));

  return {
    year,
    months,
    periods: intervals
      .filter((i) => i.to.at > yearStart && i.from.at < yearEnd)
      .map((i) => toPeriod(i, yearStart, yearEnd)),
    totals: sumMonths(months, slices),
    importFactor: factors.import,
    exportFactor: factors.export,
    readings: checkpoints.filter((c) => c.at >= yearStart && c.at < yearEnd).length,
    priced: slices.some((s) => s.source !== 'none' && hasAnyPrice(s.tariff)),
  };
}

// ---------------------------------------------------------------------------
// The cumulative curve
// ---------------------------------------------------------------------------

interface Curve {
  /**
   * Energy the smart meter counted between two instants, or null when the curve
   * does not cover both of them (no data yet, data dropped by retention, or a
   * counter that jumped backwards — a meter swap is not one continuous curve).
   */
  delta(a: number, b: number, dir: Direction): number | null;
  /**
   * Same, but over whatever part of the range the curve does cover; null only
   * when the two do not overlap at all. The running month ends at the last
   * reading rather than at midnight of the 1st, and the month a meter was
   * installed in starts when it was — both must report what is known instead of
   * falling back to nothing.
   */
  covered(a: number, b: number, dir: Direction): number | null;
  /** How much of a range the curve covers, in ms — 0 when it covers none. */
  coveredSpan(a: number, b: number): number;
}

/**
 * Linear interpolation between knots. A data gap is therefore filled by spreading
 * the energy the meter counted across it evenly — the same pro-rata assumption a
 * utility makes, applied only to the gap instead of the whole interval.
 */
function buildCurve(knots: CounterKnot[]): Curve {
  const value = (t: number, dir: Direction): number | null => {
    if (knots.length < 2 || t < knots[0].at || t > knots[knots.length - 1].at) {
      return null;
    }
    // Highest knot at or before t; knots are ordered, so a scan from the right
    // of a binary search bracket is unnecessary at these list sizes.
    let lo = 0;
    let hi = knots.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (knots[mid].at <= t) lo = mid;
      else hi = mid;
    }
    const a = knots[lo];
    const b = knots[hi];
    const av = counter(a, dir);
    const bv = counter(b, dir);
    if (b.at === a.at) return av;
    return av + ((bv - av) * (t - a.at)) / (b.at - a.at);
  };

  const delta = (a: number, b: number, dir: Direction): number | null => {
    const from = value(a, dir);
    const to = value(b, dir);
    if (from === null || to === null) return null;
    // A negative rise means the counters are not one series over this span.
    return to - from < 0 ? null : to - from;
  };

  return {
    delta,
    covered(a, b, dir) {
      if (knots.length < 2) return null;
      const lo = Math.max(a, knots[0].at);
      const hi = Math.min(b, knots[knots.length - 1].at);
      return hi > lo ? delta(lo, hi, dir) : null;
    },
    coveredSpan(a, b) {
      if (knots.length < 2) return 0;
      const lo = Math.max(a, knots[0].at);
      const hi = Math.min(b, knots[knots.length - 1].at);
      return Math.max(0, hi - lo);
    },
  };
}

function counter(k: CounterKnot, dir: Direction): number {
  return dir === 'import' ? k.importKwh : k.exportKwh;
}

// ---------------------------------------------------------------------------
// Reading intervals and the deviation factors
// ---------------------------------------------------------------------------

function buildIntervals(checkpoints: BillingCheckpoint[], curve: Curve): Interval[] {
  const intervals: Interval[] = [];
  for (let i = 1; i < checkpoints.length; i++) {
    const from = checkpoints[i - 1];
    const to = checkpoints[i];
    const meterImportKwh = to.importKwh - from.importKwh;
    const meterExportKwh = to.exportKwh - from.exportKwh;
    intervals.push({
      from,
      to,
      meterImportKwh,
      meterExportKwh,
      smartImportKwh: curve.delta(from.at, to.at, 'import'),
      smartExportKwh: curve.delta(from.at, to.at, 'export'),
      // A backwards physical counter is a meter swap or a typo; either way the
      // delta is not energy that was consumed, in either direction.
      validCounters: meterImportKwh >= 0 && meterExportKwh >= 0,
    });
  }
  return intervals;
}

/**
 * Physical over smart across every interval comparable in this direction — one
 * factor for the whole data set rather than per interval, because a single
 * interval's factor carries the full weight of its two endpoint lookups, while
 * the pooled one averages them out. Only used for stretches with no physical
 * delta of their own. Checked per direction: an interval with, say, no smart
 * export data can still teach the import factor, and vice versa.
 */
function meanFactor(intervals: Interval[], dir: Direction): number | null {
  let meter = 0;
  let smart = 0;
  for (const i of intervals) {
    if (!i.validCounters) continue;
    const smartKwh = dir === 'import' ? i.smartImportKwh : i.smartExportKwh;
    if (smartKwh === null || smartKwh <= 0) continue;
    meter += dir === 'import' ? i.meterImportKwh : i.meterExportKwh;
    smart += smartKwh;
  }
  return smart > 0 ? round4(meter / smart) : null;
}

// ---------------------------------------------------------------------------
// Slicing
// ---------------------------------------------------------------------------

/**
 * Cut the year at every instant that changes how energy must be attributed: a
 * month starts, a tariff takes effect, or a reading interval begins or ends. A
 * slice therefore never straddles any of the three.
 */
function sliceYear(
  monthStarts: number[],
  checkpoints: BillingCheckpoint[],
  tariffs: BillingTariff[],
): Array<Pick<Slice, 'from' | 'to' | 'monthIndex' | 'tariff'>> {
  const yearStart = monthStarts[0];
  const yearEnd = monthStarts[monthStarts.length - 1];
  const inside = (t: number) => t > yearStart && t < yearEnd;

  const cuts = [
    ...monthStarts,
    ...tariffs.map((t) => t.at).filter(inside),
    ...checkpoints.map((c) => c.at).filter(inside),
  ].sort((a, b) => a - b);

  const slices: Array<Pick<Slice, 'from' | 'to' | 'monthIndex' | 'tariff'>> = [];
  for (let i = 1; i < cuts.length; i++) {
    const from = cuts[i - 1];
    const to = cuts[i];
    if (to <= from) continue; // deduplicates coinciding cuts
    slices.push({
      from,
      to,
      monthIndex: monthIndexOf(from, monthStarts),
      tariff: tariffOn(from, tariffs),
    });
  }
  return slices;
}

function monthIndexOf(t: number, monthStarts: number[]): number {
  let idx = 0;
  for (let i = 0; i < 12; i++) {
    if (monthStarts[i] <= t) idx = i;
  }
  return idx;
}

/**
 * The tariff in effect at an instant: the latest one that has taken effect. The
 * oldest tariff extends backward, so data older than every tariff is still
 * priced — same rule the day/week/month costs follow.
 */
function tariffOn(t: number, tariffs: BillingTariff[]): BillingTariff | undefined {
  let chosen = tariffs[0];
  for (const tp of tariffs) {
    if (tp.at <= t) chosen = tp;
    else break;
  }
  return chosen;
}

/** Attribute energy to a slice: measured share, pro rata, or smart × factor. */
function fillSlice(
  slice: Pick<Slice, 'from' | 'to' | 'monthIndex' | 'tariff'>,
  intervals: Interval[],
  curve: Curve,
  factors: Record<Direction, number | null>,
): Slice {
  const interval = intervals.find(
    (i) => i.from.at <= slice.from && slice.to <= i.to.at,
  );

  if (!interval) {
    // Outside every reading interval: nothing physical anchors this stretch, so
    // the smart meter's own energy is used, corrected by the learned factor.
    // Only the covered part counts — a half-covered month is half known, not
    // unknown.
    const imp = curve.covered(slice.from, slice.to, 'import');
    const exp = curve.covered(slice.from, slice.to, 'export');
    if (imp === null && exp === null) {
      return { ...slice, importKwh: 0, exportKwh: 0, source: 'none', billedMs: 0 };
    }
    return {
      ...slice,
      importKwh: (imp ?? 0) * (factors.import ?? 1),
      exportKwh: (exp ?? 0) * (factors.export ?? 1),
      source: 'estimated',
      billedMs: curve.coveredSpan(slice.from, slice.to),
    };
  }

  // A backwards physical counter cannot be billed as consumption at all.
  if (!interval.validCounters) {
    return { ...slice, importKwh: 0, exportKwh: 0, source: 'none', billedMs: 0 };
  }

  return {
    ...slice,
    importKwh: interval.meterImportKwh * shareOf(slice, interval, curve, 'import'),
    exportKwh: interval.meterExportKwh * shareOf(slice, interval, curve, 'export'),
    source: 'measured',
    billedMs: slice.to - slice.from,
  };
}

/**
 * How much of an interval's physical delta falls into a slice: the share of the
 * smart meter's rise over the slice, or — with no usable curve — the share of
 * the elapsed time.
 */
function shareOf(
  slice: Pick<Slice, 'from' | 'to'>,
  interval: Interval,
  curve: Curve,
  dir: Direction,
): number {
  const total = dir === 'import' ? interval.smartImportKwh : interval.smartExportKwh;
  if (interval.validCounters && total !== null && total > 0) {
    const part = curve.delta(slice.from, slice.to, dir);
    if (part !== null) return part / total;
  }
  const span = interval.to.at - interval.from.at;
  return span > 0 ? (slice.to - slice.from) / span : 0;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function monthOf(
  year: number,
  start: number,
  index: number,
  slices: Slice[],
  checkpoints: BillingCheckpoint[],
  daysInYear: number,
): BillingMonth {
  const own = slices.filter((s) => s.monthIndex === index);
  const withData = own.filter((s) => s.source !== 'none');

  let importKwh = 0;
  let exportKwh = 0;
  let importCost = 0;
  let exportRevenue = 0;
  let baseFee = 0;
  let measured = 0;
  let total = 0;

  for (const s of withData) {
    importKwh += s.importKwh;
    exportKwh += s.exportKwh;
    importCost += (s.importKwh * (s.tariff?.importCtPerKwh ?? 0)) / 100;
    exportRevenue += (s.exportKwh * (s.tariff?.exportCtPerKwh ?? 0)) / 100;
    // Pro rata by elapsed days: a standing charge accrues with time, so a month
    // still running is charged only for the part that has data.
    baseFee += ((s.tariff?.baseEurPerYear ?? 0) * (s.billedMs / MS_PER_DAY)) / daysInYear;
    total += s.importKwh + s.exportKwh;
    if (s.source === 'measured') measured += s.importKwh + s.exportKwh;
  }

  const monthEnd = own.length ? own[own.length - 1].to : start;
  const rounded = {
    importKwh: round2(importKwh),
    exportKwh: round2(exportKwh),
    importCost: round2(importCost),
    exportRevenue: round2(exportRevenue),
    baseFee: round2(baseFee),
  };

  return {
    month: monthKey(year, index),
    ...rounded,
    net: round2(rounded.importCost + rounded.baseFee - rounded.exportRevenue),
    hasData: withData.length > 0,
    measuredShare: total > 0 ? round4(measured / total) : 0,
    readings: checkpoints.filter((c) => c.at >= start && c.at < monthEnd).length,
  };
}

/**
 * Sum the *rounded* months, so the year's figures are exactly what the month
 * column adds up to — a statement whose total cannot be verified by adding up
 * the rows it is printed next to would be worse than one cent less precise.
 */
function sumMonths(months: BillingMonth[], slices: Slice[]): BillingTotals {
  const sum = (pick: (m: BillingMonth) => number) =>
    round2(months.reduce((acc, m) => acc + pick(m), 0));

  let measured = 0;
  let total = 0;
  for (const s of slices) {
    if (s.source === 'none') continue;
    total += s.importKwh + s.exportKwh;
    if (s.source === 'measured') measured += s.importKwh + s.exportKwh;
  }

  const importCost = sum((m) => m.importCost);
  const exportRevenue = sum((m) => m.exportRevenue);
  const baseFee = sum((m) => m.baseFee);

  return {
    importKwh: sum((m) => m.importKwh),
    exportKwh: sum((m) => m.exportKwh),
    importCost,
    exportRevenue,
    baseFee,
    net: round2(importCost + baseFee - exportRevenue),
    measuredShare: total > 0 ? round4(measured / total) : 0,
  };
}

function toPeriod(interval: Interval, yearStart: number, yearEnd: number): BillingPeriod {
  const days = wholeDays(interval.from.date, interval.to.date);
  return {
    fromDate: interval.from.date,
    toDate: interval.to.date,
    fromReadAt: interval.from.readAt,
    toReadAt: interval.to.readAt,
    days,
    importKwh: round2(interval.meterImportKwh),
    exportKwh: round2(interval.meterExportKwh),
    importPerDay: days > 0 ? round2(interval.meterImportKwh / days) : 0,
    withinYear: interval.from.at >= yearStart && interval.to.at <= yearEnd,
  };
}

function hasAnyPrice(t: BillingTariff | undefined): boolean {
  return t?.importCtPerKwh != null || t?.exportCtPerKwh != null;
}

/** YYYY-MM-01 — the months of a calendar year need no timezone to name. */
function monthKey(year: number, index: number): string {
  return `${year}-${String(index + 1).padStart(2, '0')}-01`;
}

/** Whole days between two YYYY-MM-DD dates (UTC math: no DST offsets). */
function wholeDays(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / MS_PER_DAY);
}
