import { describe, expect, it } from 'vitest';
import { round3 } from '../common/db-utils';
import {
  type HourEnergy,
  type StatisticsInput,
  computeStatistics,
} from './statistics';

/**
 * A full day of hours. `pv` / `imp` / `exp` are per-hour arrays of 24 values;
 * a scalar repeats for the whole day.
 */
function day(
  date: string,
  pv: number | number[],
  imp: number | number[],
  exp: number | number[] = 0,
): HourEnergy[] {
  const at = (v: number | number[], h: number) => (Array.isArray(v) ? v[h] : v);
  return Array.from({ length: 24 }, (_, hour) => ({
    day: date,
    hour,
    pvKwh: at(pv, hour),
    importKwh: at(imp, hour),
    exportKwh: at(exp, hour),
  }));
}

/** 6 kWh of sun between 10:00 and 13:00, nothing otherwise. */
const SUNNY = Array.from({ length: 24 }, (_, h) => (h >= 10 && h < 13 ? 2 : 0));

function input(over: Partial<StatisticsInput> = {}): StatisticsInput {
  return {
    hours: [],
    nights: [],
    pvPeak: null,
    housePeak: null,
    peakWindowDays: 90,
    ...over,
  };
}

describe('computeStatistics', () => {
  it('reports nothing when there is no data', () => {
    const s = computeStatistics(input());
    expect(s.days).toBe(0);
    expect(s.firstDay).toBeNull();
    expect(s.pv.bestDay).toBeNull();
    expect(s.consumption.avgDayKwh).toBeNull();
    expect(s.battery.curve).toEqual([]);
    expect(s.battery.fullAutarkyKwh).toBeNull();
  });

  it('sums house load as PV + import - feed-in per day', () => {
    // 6 kWh sun, 1 kWh fed in, 2.4 kWh imported -> 7.4 kWh consumed.
    const s = computeStatistics(
      input({ hours: day('2026-06-01', SUNNY, 0.1, [...SUNNY].fill(0).fill(1, 11, 12)) }),
    );
    expect(s.days).toBe(1);
    expect(s.pv.bestDay).toEqual({ day: '2026-06-01', kwh: 6 });
    expect(s.consumption.maxDay).toEqual({ day: '2026-06-01', kwh: 7.4 });
    expect(s.consumption.avgDayKwh).toBe(7.4);
  });

  it('picks the strongest day of several and averages over all of them', () => {
    const s = computeStatistics(
      input({
        hours: [
          ...day('2026-06-01', SUNNY, 0.1), // 6 kWh PV, 8.4 kWh house
          ...day('2026-06-02', 0, 0.5), // 0 kWh PV, 12 kWh house
        ],
      }),
    );
    expect(s.pv.bestDay).toEqual({ day: '2026-06-01', kwh: 6 });
    expect(s.consumption.maxDay).toEqual({ day: '2026-06-02', kwh: 12 });
    expect(s.consumption.avgDayKwh).toBe(10.2);
    expect(s.firstDay).toBe('2026-06-01');
    expect(s.lastDay).toBe('2026-06-02');
  });

  it('skips days that are short of hours or missing inverter data', () => {
    const short = day('2026-06-01', 0, 1).slice(0, 20);
    const noPv = day('2026-06-02', SUNNY, 1).map((h) =>
      h.hour === 11 ? { ...h, pvKwh: null } : h,
    );
    const s = computeStatistics(input({ hours: [...short, ...noPv, ...day('2026-06-03', 0, 1)] }));
    expect(s.days).toBe(1);
    expect(s.firstDay).toBe('2026-06-03');
  });

  it('keeps a day whose only missing inverter hour was dark anyway', () => {
    const gapAtNight = day('2026-06-02', SUNNY, 1).map((h) =>
      h.hour === 3 ? { ...h, pvKwh: null } : h,
    );
    const s = computeStatistics(input({ hours: gapAtNight }));
    expect(s.days).toBe(1);
    expect(s.pv.bestDay?.kwh).toBe(6);
  });

  it('still drops a day whose missing inverter hour was in daylight', () => {
    const gapAtNoon = day('2026-06-02', SUNNY, 1).map((h) =>
      h.hour === 11 ? { ...h, pvKwh: null } : h,
    );
    expect(computeStatistics(input({ hours: gapAtNoon })).days).toBe(0);
  });

  it('keeps a day whose inverter dropped out for a few hours overnight', () => {
    const gapAtNight = day('2026-06-02', SUNNY, 1).map((h) =>
      h.hour >= 1 && h.hour <= 3 ? { ...h, pvKwh: null } : h,
    );
    const s = computeStatistics(input({ hours: gapAtNight }));
    expect(s.days).toBe(1);
    expect(s.pv.bestDay?.kwh).toBe(6);
  });

  it('does not treat a whole missing daylight span as zero production', () => {
    // Hours 1..22 missing — bounded by dark hours 0 and 23, but far too long
    // to assume it was night. A real outage like this must stay unmeasured,
    // not turn into a false "0 kWh" record.
    const allDayGap = day('2026-06-02', SUNNY, 1).map((h) =>
      h.hour >= 1 && h.hour <= 22 ? { ...h, pvKwh: null } : h,
    );
    expect(computeStatistics(input({ hours: allDayGap })).days).toBe(0);
  });

  it('keeps a 23-hour day: that is the DST day, not a gap', () => {
    const dst = day('2026-03-29', 0, 1).filter((h) => h.hour !== 2);
    expect(computeStatistics(input({ hours: dst })).days).toBe(1);
  });

  it('passes the peaks through untouched', () => {
    const pvPeak = { time: '2026-06-01T11:00:00.000Z', powerW: 6400 };
    const housePeak = { time: '2026-06-02T18:12:00.000Z', powerW: 7553 };
    const s = computeStatistics(input({ pvPeak, housePeak, peakWindowDays: 42 }));
    expect(s.pv.peak).toBe(pvPeak);
    expect(s.consumption.peak).toBe(housePeak);
    expect(s.peakWindowDays).toBe(42);
  });
});

describe('standby', () => {
  it('averages the nightly base loads and projects them', () => {
    const s = computeStatistics(
      input({
        // 10 kWh/day house load, so the 250 W base load is 6 kWh of it.
        hours: day('2026-06-01', 0, 10 / 24),
        nights: [
          { day: '2026-06-01', watts: 200 },
          { day: '2026-06-02', watts: 300 },
        ],
      }),
    );
    expect(s.standby.avgW).toBe(250);
    expect(s.standby.minW).toBe(200);
    expect(s.standby.maxW).toBe(300);
    expect(s.standby.nights).toBe(2);
    expect(s.standby.perDayKwh).toBe(6);
    expect(s.standby.perYearKwh).toBe(2190);
    expect(s.standby.shareOfConsumption).toBe(0.6);
  });

  it('has no share without a day to compare against', () => {
    const s = computeStatistics(input({ nights: [{ day: '2026-06-01', watts: 250 }] }));
    expect(s.standby.avgW).toBe(250);
    expect(s.standby.shareOfConsumption).toBeNull();
  });
});

describe('battery sizing', () => {
  // Every week day the same: 6 kWh of sun, 5 kWh of it fed in around noon, and
  // 4 kWh imported through the night. Feeding in 5 kWh to get 4 kWh back out
  // covers the night exactly at 90 % efficiency, so a 4 kWh battery does it.
  const CYCLE = Array.from({ length: 7 }, (_, i) =>
    day(
      `2026-06-0${i + 1}`,
      SUNNY,
      Array.from({ length: 24 }, (_, h) => (h < 6 ? 4 / 6 : 0)),
      Array.from({ length: 24 }, (_, h) => (h >= 10 && h < 13 ? 5 / 3 : 0)),
    ).flat(),
  ).flat();

  it('reports the measured autarky as the 0 kWh point', () => {
    const b = computeStatistics(input({ hours: CYCLE })).battery;
    // 5 kWh consumed a day (6 sun + 4 grid - 5 fed in), 4 kWh of it imported.
    expect(b.consumptionKwh).toBe(35);
    expect(b.productionKwh).toBe(42);
    expect(b.baseAutarky).toBe(0.2);
    expect(b.curve[0]).toEqual({
      capacityKwh: 0,
      autarky: 0.2,
      selfConsumption: round3(1 - 35 / 42),
    });
  });

  it('finds the size that removes the last kWh of grid import', () => {
    const b = computeStatistics(input({ hours: CYCLE })).battery;
    expect(b.fullAutarkyKwh).toBe(4);
    expect(b.curve.find((p) => p.capacityKwh === 4)?.autarky).toBe(1);
    // Half a night short of it, half the night's import is left.
    expect(b.curve.find((p) => p.capacityKwh === 2)?.autarky).toBe(0.6);
  });

  it('is monotonic and never exceeds full autarky', () => {
    const b = computeStatistics(input({ hours: CYCLE })).battery;
    for (const [i, point] of b.curve.entries()) {
      expect(point.autarky).toBeLessThanOrEqual(1);
      expect(point.selfConsumption).toBeLessThanOrEqual(1);
      if (i > 0) expect(point.autarky).toBeGreaterThanOrEqual(b.curve[i - 1].autarky);
    }
  });

  it('stops the recommendation where another kWh stops paying', () => {
    const b = computeStatistics(input({ hours: CYCLE })).battery;
    expect(b.kneeKwh).toBe(4);
    expect(b.kneeAutarky).toBe(1);
  });

  it('gives up when the sun never covers the load', () => {
    // Consumption all night, no production at all: no size can help.
    const b = computeStatistics(input({ hours: day('2026-01-01', 0, 0.5) })).battery;
    expect(b.fullAutarkyKwh).toBeNull();
    expect(b.kneeKwh).toBe(0);
    expect(b.baseAutarky).toBe(0);
    expect(b.curve.at(-1)?.autarky).toBe(0);
  });

  it('does not carry charge across a gap in the data', () => {
    // Day 1 banks a surplus, day 3 needs it — with day 2 missing, the battery
    // cannot have kept it, and the import stays.
    const hours = [
      ...day('2026-06-01', SUNNY, 0, [...SUNNY]),
      ...day('2026-06-03', 0, 0.25),
    ];
    const b = computeStatistics(input({ hours })).battery;
    expect(b.fullAutarkyKwh).toBeNull();
  });

  it('measures the night a battery has to bridge', () => {
    const hours = [
      ...day('2026-06-01', SUNNY, Array.from({ length: 24 }, (_, h) => (h < 6 ? 1 : 0))),
      ...day('2026-06-02', SUNNY, Array.from({ length: 24 }, (_, h) => (h < 6 ? 2 : 0))),
    ];
    const b = computeStatistics(input({ hours })).battery;
    expect(b.medianNightKwh).toBe(9);
    expect(b.maxNightKwh).toBe(12);
  });
});
