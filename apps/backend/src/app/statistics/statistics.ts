import type {
  BatteryCurvePoint,
  BatteryStatistics,
  StatDayRecord,
  StatPeak,
  StatisticsResponse,
} from '@org/shared-types';
import { round2, round3 } from '../common/db-utils';

/**
 * One hour of energy, already resolved to the local day and hour it falls in.
 * The caller does that conversion (in SQL, where the timezone database lives),
 * so everything here is plain arithmetic over labelled buckets.
 */
export interface HourEnergy {
  /** Local day, YYYY-MM-DD. */
  day: string;
  /** Local hour of day, 0..23. */
  hour: number;
  /** PV production in this hour; null when the inverter has no data for it. */
  pvKwh: number | null;
  /** Grid import / feed-in during the hour, from the meter's counters. */
  importKwh: number;
  exportKwh: number;
}

/** One night's measured base load. */
export interface NightBaseline {
  /** Local day the night belongs to, YYYY-MM-DD. */
  day: string;
  watts: number;
}

export interface StatisticsInput {
  /** Hourly energy, ascending. Gaps are simply absent rows. */
  hours: HourEnergy[];
  nights: NightBaseline[];
  /** Peaks read straight from the power aggregates. */
  pvPeak: StatPeak | null;
  housePeak: StatPeak | null;
  /** Retention of the 1-minute aggregate the house peak comes from, in days. */
  peakWindowDays: number;
}

/**
 * Round-trip efficiency assumed for the battery, charged against the surplus
 * (10 % of what goes in never comes back out). Discharge is then lossless, so
 * the loss is counted exactly once.
 */
const BATTERY_EFFICIENCY = 0.9;

/** Below this an hour counts as dark — the hours a battery has to bridge. */
const DARK_KWH = 0.05;

/**
 * Hours a day needs to count as complete. 23, not 24: the spring DST day has
 * one hour less, and a day that is short one hour would still be excluded from
 * the records for good reason if it were a real gap — this only tolerates the
 * clock change.
 */
const MIN_HOURS_PER_DAY = 23;

/** Largest battery the sizing search considers, and its resolution (kWh). */
const SEARCH_MAX_KWH = 100;
const SEARCH_STEPS_PER_KWH = 2;

/** Grid import under this share of consumption counts as "no import left". */
const FULL_AUTARKY_TOLERANCE = 0.001;

/** Below this autarky gain per added kWh, growing the battery stops paying. */
const KNEE_GAIN_PER_KWH = 0.01;

/** The curve always covers at least this, and never more than that (kWh). */
const CURVE_MIN_KWH = 20;
const CURVE_MAX_KWH = 60;

/** A day with complete hourly data, summed up. */
interface DayEnergy {
  day: string;
  pvKwh: number;
  houseKwh: number;
  /** Consumption during the dark hours — one night's worth of storage. */
  nightKwh: number;
  /** The day's hours in order, for the battery simulation. */
  flows: HourFlow[];
}

/** What the meter saw in one hour: the battery simulation needs nothing else. */
interface HourFlow {
  importKwh: number;
  exportKwh: number;
}

interface SimResult {
  /** Grid import left after the battery has done what it can, kWh. */
  gridKwh: number;
  /** Feed-in left after charging, kWh. */
  feedInKwh: number;
}

/**
 * All-time statistics over the stored data.
 *
 * Every daily figure rests on {@link buildDays}' complete days only: a day the
 * collector missed half of would otherwise set a "record low" consumption, and
 * an hour without inverter data would book its PV production as consumption.
 */
export function computeStatistics(input: StatisticsInput): StatisticsResponse {
  const days = buildDays(fillDarkGaps(input.hours));
  const battery = sizeBattery(days);

  const avgDay = (pick: (d: DayEnergy) => number): number | null =>
    days.length ? round2(days.reduce((sum, d) => sum + pick(d), 0) / days.length) : null;

  return {
    firstDay: days.length ? days[0].day : null,
    lastDay: days.length ? days[days.length - 1].day : null,
    days: days.length,
    peakWindowDays: input.peakWindowDays,
    pv: {
      peak: input.pvPeak,
      bestDay: bestDay(days, (d) => d.pvKwh),
      avgDayKwh: avgDay((d) => d.pvKwh),
    },
    consumption: {
      peak: input.housePeak,
      maxDay: bestDay(days, (d) => d.houseKwh),
      avgDayKwh: avgDay((d) => d.houseKwh),
    },
    standby: standby(input.nights, avgDay((d) => d.houseKwh)),
    battery,
  };
}

/**
 * Fill the PV gaps that are provably dark: an hour without inverter data whose
 * neighbouring hours both produced nothing sat in the middle of the night, and
 * night production is zero, not unknown.
 *
 * Worth the special case because the inverter is the flaky end of the chain —
 * it loses its Speedwire socket now and then — and without this a single
 * missed poll at 3 a.m. would throw away the whole day's records.
 */
function fillDarkGaps(hours: HourEnergy[]): HourEnergy[] {
  return hours.map((h, i) => {
    if (h.pvKwh !== null) return h;
    const before = hours[i - 1];
    const after = hours[i + 1];
    const dark = (n: HourEnergy | undefined): boolean =>
      n !== undefined && n.pvKwh !== null && n.pvKwh < DARK_KWH;
    if (!dark(before) || !dark(after)) return h;
    // Only when those neighbours really are the adjacent hours — over a gap in
    // the meter data too, "dark before and after" says nothing about between.
    if (!adjacent(before, h) || !adjacent(h, after)) return h;
    return { ...h, pvKwh: 0 };
  });
}

/** Whether `b` is the hour right after `a`. */
function adjacent(a: HourEnergy, b: HourEnergy): boolean {
  return a.day === b.day
    ? b.hour === a.hour + 1
    : a.hour === 23 && b.hour === 0 && b.day === nextDay(a.day);
}

/**
 * Group the hourly rows into complete local days.
 *
 * "Complete" means (nearly) every hour is there *and* every one of them has
 * inverter data: house load is PV + import − feed-in, so an hour whose PV is
 * unknown has an unknown house load too — at noon it would land far below the
 * truth, and even go negative while the surplus is being fed in.
 */
function buildDays(hours: HourEnergy[]): DayEnergy[] {
  const byDay = new Map<string, HourEnergy[]>();
  for (const h of hours) {
    const list = byDay.get(h.day);
    if (list) list.push(h);
    else byDay.set(h.day, [h]);
  }

  const days: DayEnergy[] = [];
  for (const [day, list] of byDay) {
    if (list.length < MIN_HOURS_PER_DAY) continue;
    if (list.some((h) => h.pvKwh === null)) continue;

    const d: DayEnergy = { day, pvKwh: 0, houseKwh: 0, nightKwh: 0, flows: [] };
    for (const h of [...list].sort((a, b) => a.hour - b.hour)) {
      const pv = h.pvKwh ?? 0;
      // Clamped: rounding in the three counters can push a quiet hour a few Wh
      // below zero, and negative consumption is not a thing.
      const house = Math.max(pv + h.importKwh - h.exportKwh, 0);
      d.pvKwh += pv;
      d.houseKwh += house;
      if (pv < DARK_KWH) d.nightKwh += house;
      d.flows.push({ importKwh: h.importKwh, exportKwh: h.exportKwh });
    }
    days.push(d);
  }
  return days.sort((a, b) => (a.day < b.day ? -1 : 1));
}

function bestDay(
  days: DayEnergy[],
  pick: (d: DayEnergy) => number,
): StatDayRecord | null {
  let best: DayEnergy | null = null;
  for (const d of days) if (!best || pick(d) > pick(best)) best = d;
  return best ? { day: best.day, kwh: round2(pick(best)) } : null;
}

/**
 * Nightly base loads averaged into one figure, plus what it costs over a day
 * and a year. `avgDayKwh` only serves the share; without it that stays null.
 */
function standby(
  nights: NightBaseline[],
  avgDayKwh: number | null,
): StatisticsResponse['standby'] {
  if (!nights.length) {
    return {
      avgW: null,
      minW: null,
      maxW: null,
      nights: 0,
      perDayKwh: null,
      perYearKwh: null,
      shareOfConsumption: null,
    };
  }
  const watts = nights.map((n) => n.watts);
  const avgW = watts.reduce((a, b) => a + b, 0) / watts.length;
  const perDayKwh = (avgW * 24) / 1000;
  return {
    avgW: Math.round(avgW),
    minW: Math.round(Math.min(...watts)),
    maxW: Math.round(Math.max(...watts)),
    nights: nights.length,
    perDayKwh: round2(perDayKwh),
    perYearKwh: round2(perDayKwh * 365),
    shareOfConsumption:
      avgDayKwh && avgDayKwh > 0 ? round3(perDayKwh / avgDayKwh) : null,
  };
}

/**
 * How large a battery would have to be, simulated against what actually
 * happened: every kWh the meter imported is offered to the battery first, and
 * every kWh that went out as feed-in charges it instead.
 *
 * The measured import/export *are* the surplus and deficit (house load is
 * defined as PV + import − feed-in), so the simulation needs no assumption
 * about how load and production line up inside an hour beyond the usual
 * self-consumption priority.
 */
function sizeBattery(days: DayEnergy[]): BatteryStatistics {
  const empty: BatteryStatistics = {
    baseAutarky: null,
    curve: [],
    fullAutarkyKwh: null,
    kneeKwh: null,
    kneeAutarky: null,
    medianNightKwh: null,
    maxNightKwh: null,
    productionKwh: 0,
    consumptionKwh: 0,
    efficiency: BATTERY_EFFICIENCY,
  };
  if (!days.length) return empty;

  const runs = contiguousRuns(days);
  const consumptionKwh = days.reduce((s, d) => s + d.houseKwh, 0);
  const productionKwh = days.reduce((s, d) => s + d.pvKwh, 0);
  if (consumptionKwh <= 0) return { ...empty, productionKwh: round2(productionKwh) };

  const cache = new Map<number, SimResult>();
  const sim = (capacityKwh: number): SimResult => {
    const hit = cache.get(capacityKwh);
    if (hit) return hit;
    const r = simulate(runs, capacityKwh);
    cache.set(capacityKwh, r);
    return r;
  };
  const autarky = (capacityKwh: number): number =>
    1 - sim(capacityKwh).gridKwh / consumptionKwh;

  // Smallest size that leaves no grid import. Scanned rather than solved: the
  // battery is state-dependent (it can only give back what it stored earlier),
  // so there is no closed form for it.
  let fullAutarkyKwh: number | null = null;
  for (let step = 0; step <= SEARCH_MAX_KWH * SEARCH_STEPS_PER_KWH; step++) {
    const capacity = step / SEARCH_STEPS_PER_KWH;
    if (sim(capacity).gridKwh <= consumptionKwh * FULL_AUTARKY_TOLERANCE) {
      fullAutarkyKwh = capacity;
      break;
    }
  }

  // The curve reaches past the answer where there is one, so the size the text
  // names is also visible in the chart.
  const curveMax = Math.min(
    CURVE_MAX_KWH,
    Math.max(CURVE_MIN_KWH, Math.ceil(fullAutarkyKwh ?? 0)),
  );
  const curve: BatteryCurvePoint[] = [];
  for (let capacityKwh = 0; capacityKwh <= curveMax; capacityKwh++) {
    const r = sim(capacityKwh);
    curve.push({
      capacityKwh,
      autarky: round3(1 - r.gridKwh / consumptionKwh),
      selfConsumption:
        productionKwh > 0 ? round3(1 - r.feedInKwh / productionKwh) : 0,
    });
  }

  // Diminishing returns: the last size whose next kWh still buys a full point
  // of autarky. 0 means even the first kWh does not — then a battery is simply
  // not the lever.
  let kneeKwh = 0;
  for (let capacityKwh = 0; capacityKwh < curveMax; capacityKwh++) {
    if (autarky(capacityKwh + 1) - autarky(capacityKwh) < KNEE_GAIN_PER_KWH) break;
    kneeKwh = capacityKwh + 1;
  }

  const nights = days.map((d) => d.nightKwh).sort((a, b) => a - b);
  return {
    baseAutarky: round3(autarky(0)),
    curve,
    fullAutarkyKwh,
    kneeKwh,
    kneeAutarky: round3(autarky(kneeKwh)),
    medianNightKwh: round2(median(nights)),
    maxNightKwh: round2(nights[nights.length - 1]),
    productionKwh: round2(productionKwh),
    consumptionKwh: round2(consumptionKwh),
    efficiency: BATTERY_EFFICIENCY,
  };
}

/**
 * Split the days into stretches of consecutive calendar days. The battery's
 * charge carries from one hour to the next, which it may only do across days
 * that actually follow each other — over a gap in the data the state of charge
 * is unknown, and carrying it would hand the simulation energy for free.
 */
function contiguousRuns(days: DayEnergy[]): HourFlow[][] {
  const runs: HourFlow[][] = [];
  let current: HourFlow[] = [];
  let previous: string | null = null;
  for (const d of days) {
    if (previous !== null && d.day !== nextDay(previous)) {
      runs.push(current);
      current = [];
    }
    current.push(...d.flows);
    previous = d.day;
  }
  if (current.length) runs.push(current);
  return runs;
}

/** The calendar day after `day` (YYYY-MM-DD), as a label again. */
function nextDay(day: string): string {
  // Parsed as UTC on purpose: these are calendar labels, not instants, and UTC
  // is the one zone where "+24 h" never lands on the same or a skipped date.
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Run one battery size over every stretch of days.
 *
 * Each stretch is simulated twice, the second pass starting from the charge the
 * first one ended on. Starting empty would charge the first night to the grid
 * for every size alike, starting full would hand out kWh the period never
 * produced; the fixed point between them is the state the same weather leaves
 * the battery in, which is what a battery that has been there all along has.
 */
function simulate(runs: HourFlow[][], capacityKwh: number): SimResult {
  const result: SimResult = { gridKwh: 0, feedInKwh: 0 };
  for (const run of runs) {
    const warm = runFlows(run, capacityKwh, 0, null);
    runFlows(run, capacityKwh, warm, result);
  }
  return result;
}

/**
 * One pass over a stretch of hours; returns the state of charge it ends on and
 * adds what the grid still had to supply / absorb to `out` when given.
 */
function runFlows(
  flows: HourFlow[],
  capacityKwh: number,
  startSoc: number,
  out: SimResult | null,
): number {
  let soc = Math.min(startSoc, capacityKwh);
  for (const f of flows) {
    // Discharge first (self-consumption before storing anything).
    const fromBattery = Math.min(f.importKwh, soc);
    soc -= fromBattery;
    // Then charge with the surplus, as far as the free room allows. The losses
    // sit here, so `room` is the *grid-side* energy that still fits.
    const room = (capacityKwh - soc) / BATTERY_EFFICIENCY;
    const charged = Math.min(f.exportKwh, room);
    soc += charged * BATTERY_EFFICIENCY;
    if (out) {
      out.gridKwh += f.importKwh - fromBattery;
      out.feedInKwh += f.exportKwh - charged;
    }
  }
  return soc;
}

/** Median of an ascending array (mean of the middle two when even). */
function median(ascending: number[]): number {
  const mid = ascending.length >> 1;
  return ascending.length % 2
    ? ascending[mid]
    : (ascending[mid - 1] + ascending[mid]) / 2;
}
