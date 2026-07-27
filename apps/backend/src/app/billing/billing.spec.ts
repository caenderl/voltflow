import { describe, expect, it } from 'vitest';
import {
  type BillingCheckpoint,
  type BillingInput,
  type BillingTariff,
  type CounterKnot,
  computeBillingStatement,
  curveWindow,
} from './billing';

// The module compares instants only, so the tests can pretend everything is UTC.
const at = (iso: string) => Date.parse(iso);
const MONTH_STARTS = Array.from({ length: 13 }, (_, i) => Date.UTC(2026, i, 1));

const TARIFF: BillingTariff = {
  at: at('2020-01-01T00:00:00Z'),
  importCtPerKwh: 30,
  exportCtPerKwh: 8,
  baseEurPerYear: 144.86,
};

function checkpoint(
  iso: string,
  importKwh: number,
  exportKwh: number,
): BillingCheckpoint {
  return {
    date: iso.slice(0, 10),
    readAt: iso.slice(11, 16),
    at: at(iso),
    importKwh,
    exportKwh,
  };
}

function knot(iso: string, importKwh: number, exportKwh: number): CounterKnot {
  return { at: at(iso), importKwh, exportKwh };
}

function input(over: Partial<BillingInput> = {}): BillingInput {
  return {
    year: 2026,
    monthStarts: MONTH_STARTS,
    checkpoints: [],
    knots: [],
    tariffs: [TARIFF],
    daysInYear: 365,
    ...over,
  };
}

/** Same 4-decimal rounding the module applies to shares and factors. */
const round = (v: number) => Math.round(v * 10000) / 10000;

/** A curve rising at a constant rate, one knot per day. */
function uniformKnots(fromIso: string, days: number, perDay: number): CounterKnot[] {
  const start = at(fromIso);
  return Array.from({ length: days + 1 }, (_, i) =>
    knot(new Date(start + i * 86_400_000).toISOString(), i * perDay, i * perDay * 0.1),
  );
}

describe('computeBillingStatement', () => {
  it('distributes a physical delta by the shape of the curve, not its level', () => {
    // The smart meter rises 100 in January and 200 in February — half of what
    // the physical meter counted. Only the 1:2 shape may reach the months.
    const s = computeBillingStatement(
      input({
        checkpoints: [
          checkpoint('2026-01-01T00:00:00Z', 1000, 500),
          checkpoint('2026-03-01T00:00:00Z', 1600, 560),
        ],
        knots: [
          knot('2026-01-01T00:00:00Z', 0, 0),
          knot('2026-02-01T00:00:00Z', 100, 10),
          knot('2026-03-01T00:00:00Z', 300, 30),
        ],
      }),
    );

    expect(s.months[0].importKwh).toBe(200);
    expect(s.months[1].importKwh).toBe(400);
    expect(s.months[0].exportKwh).toBe(20);
    expect(s.months[1].exportKwh).toBe(40);
    // The two months together are exactly what was read off the meter.
    expect(s.months[0].importKwh + s.months[1].importKwh).toBe(600);
    expect(s.months[0].measuredShare).toBe(1);
    expect(s.importFactor).toBe(2);
  });

  it('bills each month and lets the year total add up from the rows', () => {
    const s = computeBillingStatement(
      input({
        checkpoints: [
          checkpoint('2026-01-01T00:00:00Z', 1000, 500),
          checkpoint('2026-03-01T00:00:00Z', 1600, 560),
        ],
        knots: [
          knot('2026-01-01T00:00:00Z', 0, 0),
          knot('2026-02-01T00:00:00Z', 100, 10),
          knot('2026-03-01T00:00:00Z', 300, 30),
        ],
      }),
    );

    // 200 kWh × 30 ct, minus 20 kWh × 8 ct, plus 31/365 of 144.86 €.
    expect(s.months[0].importCost).toBe(60);
    expect(s.months[0].exportRevenue).toBe(1.6);
    expect(s.months[0].baseFee).toBe(12.3);
    // The consumption contract on its own: work price + standing charge, never
    // netted against the feed-in contract's revenue.
    expect(s.months[0].importTotal).toBe(72.3);
    expect(s.months[1].baseFee).toBe(11.11);

    expect(s.totals.importCost).toBe(180);
    expect(s.totals.baseFee).toBe(23.41);
    expect(s.totals.importTotal).toBe(203.41);
    expect(s.totals.exportRevenue).toBe(4.8);
    // Hand-verifiable: the total is what the printed month rows add up to, to
    // the cent. Compared loosely because summing two 2-decimal floats leaves
    // noise the total's own rounding removes — that removal is the point.
    expect(s.totals.importTotal).toBeCloseTo(
      s.months[0].importTotal + s.months[1].importTotal,
      2,
    );
    expect(s.priced).toBe(true);
  });

  it('splits an interval that straddles a month boundary without losing kWh', () => {
    const s = computeBillingStatement(
      input({
        checkpoints: [
          checkpoint('2026-01-15T00:00:00Z', 1000, 0),
          checkpoint('2026-02-15T00:00:00Z', 1310, 0),
        ],
        // Data exactly for the interval, so nothing but the seam is under test.
        knots: uniformKnots('2026-01-15T00:00:00Z', 31, 10),
      }),
    );

    // 31 days at a constant rate: 17 fall in January, 14 in February.
    expect(s.months[0].importKwh).toBe(170);
    expect(s.months[1].importKwh).toBe(140);
    expect(s.months[0].importKwh + s.months[1].importKwh).toBe(310);
  });

  it('counts the stretch before the first reading as estimated, not as missing', () => {
    const s = computeBillingStatement(
      input({
        checkpoints: [
          checkpoint('2026-01-15T00:00:00Z', 1000, 0),
          checkpoint('2026-02-15T00:00:00Z', 1310, 0),
        ],
        knots: uniformKnots('2026-01-01T00:00:00Z', 60, 10),
      }),
    );

    // January is 14 estimated days before the first reading plus 17 measured
    // ones after it — the share must say so instead of claiming a measured month.
    expect(s.months[0].importKwh).toBe(310);
    expect(s.months[0].measuredShare).toBe(round(170 / 310));
    expect(s.months[0].hasData).toBe(true);
  });

  it('prices a tariff change inside a month at both prices', () => {
    const s = computeBillingStatement(
      input({
        tariffs: [
          { ...TARIFF, baseEurPerYear: null },
          {
            at: at('2026-01-20T00:00:00Z'),
            importCtPerKwh: 40,
            exportCtPerKwh: 8,
            baseEurPerYear: null,
          },
        ],
        checkpoints: [
          checkpoint('2026-01-01T00:00:00Z', 1000, 0),
          checkpoint('2026-02-01T00:00:00Z', 1310, 0),
        ],
        knots: uniformKnots('2026-01-01T00:00:00Z', 31, 10),
      }),
    );

    // 19 days × 10 kWh at 30 ct + 12 days × 10 kWh at 40 ct.
    expect(s.months[0].importKwh).toBe(310);
    expect(s.months[0].importCost).toBe(57 + 48);
  });

  it('falls back to a pro-rata split when the curve does not cover an interval', () => {
    const s = computeBillingStatement(
      input({
        checkpoints: [
          checkpoint('2026-01-01T00:00:00Z', 1000, 200),
          checkpoint('2026-03-01T00:00:00Z', 1590, 259),
        ],
        knots: [],
      }),
    );

    // 59 days, 590 kWh: 31 days of January get 310 kWh, February 280.
    expect(s.months[0].importKwh).toBe(310);
    expect(s.months[1].importKwh).toBe(280);
    // Still anchored on the readings — only the distribution is assumed.
    expect(s.months[0].measuredShare).toBe(1);
    expect(s.importFactor).toBeNull();
  });

  it('estimates the stretch after the last reading with the learned factor', () => {
    const s = computeBillingStatement(
      input({
        checkpoints: [
          checkpoint('2026-01-01T00:00:00Z', 1000, 0),
          checkpoint('2026-02-01T00:00:00Z', 1200, 0),
        ],
        knots: [
          knot('2026-01-01T00:00:00Z', 0, 0),
          knot('2026-02-01T00:00:00Z', 100, 0),
          knot('2026-03-01T00:00:00Z', 150, 0),
        ],
      }),
    );

    expect(s.importFactor).toBe(2);
    expect(s.months[0].measuredShare).toBe(1);
    // February has no reading to anchor it: 50 kWh counted × factor 2.
    expect(s.months[1].importKwh).toBe(100);
    expect(s.months[1].measuredShare).toBe(0);
    expect(s.months[1].hasData).toBe(true);
    // Beyond the curve there is nothing to say at all.
    expect(s.months[2].hasData).toBe(false);
    expect(s.months[2].importKwh).toBe(0);
  });

  it('refuses to bill an interval whose physical counter jumped backwards', () => {
    const s = computeBillingStatement(
      input({
        checkpoints: [
          checkpoint('2026-01-01T00:00:00Z', 9000, 0),
          // Meter swapped: the new counter starts near zero.
          checkpoint('2026-02-01T00:00:00Z', 12, 0),
        ],
        knots: uniformKnots('2026-01-01T00:00:00Z', 31, 10),
      }),
    );

    expect(s.months[0].hasData).toBe(false);
    expect(s.months[0].importKwh).toBe(0);
    expect(s.totals.importKwh).toBe(0);
  });

  it('reports the reading intervals and how the year is anchored', () => {
    const s = computeBillingStatement(
      input({
        checkpoints: [
          checkpoint('2025-12-20T18:30:00Z', 900, 0),
          checkpoint('2026-01-20T07:15:00Z', 1210, 0),
        ],
        knots: uniformKnots('2025-12-01T00:00:00Z', 90, 10),
      }),
    );

    expect(s.periods).toHaveLength(1);
    expect(s.periods[0]).toMatchObject({
      fromDate: '2025-12-20',
      toDate: '2026-01-20',
      fromReadAt: '18:30',
      days: 31,
      importKwh: 310,
      importPerDay: 10,
      // Reaches into the previous year, so it is not a period of 2026 alone.
      withinYear: false,
    });
    // Only the reading taken in 2026 counts as anchoring this year.
    expect(s.readings).toBe(1);
  });

  it('reports no prices when the tariff carries none', () => {
    const s = computeBillingStatement(
      input({
        tariffs: [
          { at: at('2020-01-01T00:00:00Z'), importCtPerKwh: null, exportCtPerKwh: null, baseEurPerYear: null },
        ],
        checkpoints: [
          checkpoint('2026-01-01T00:00:00Z', 1000, 0),
          checkpoint('2026-02-01T00:00:00Z', 1310, 0),
        ],
        knots: uniformKnots('2026-01-01T00:00:00Z', 31, 10),
      }),
    );

    expect(s.priced).toBe(false);
    expect(s.months[0].importKwh).toBe(310);
    expect(s.months[0].importCost).toBe(0);
  });

  it('reports the covered part of a month and accrues the base fee only for it', () => {
    // What the running month looks like: the curve stops at the last reading,
    // and the month before the meter existed starts partway through.
    const s = computeBillingStatement(
      input({ knots: uniformKnots('2026-06-24T00:00:00Z', 11, 10) }),
    );

    expect(s.months[4].hasData).toBe(false); // May: nothing at all
    expect(s.months[5].importKwh).toBe(70); // June: 7 covered days
    expect(s.months[6].importKwh).toBe(40); // July: 4 covered days
    expect(s.months[7].hasData).toBe(false); // August: not yet

    // 7/365 and 4/365 of 144.86 € — not a full month each.
    expect(s.months[5].baseFee).toBe(2.78);
    expect(s.months[6].baseFee).toBe(1.59);
    expect(s.months[5].measuredShare).toBe(0);
  });

  it('stays empty rather than inventing zeros without any data', () => {
    const s = computeBillingStatement(input());

    expect(s.months).toHaveLength(12);
    expect(s.months.every((m) => !m.hasData)).toBe(true);
    expect(s.totals.importTotal).toBe(0);
    expect(s.totals.measuredShare).toBe(0);
    expect(s.readings).toBe(0);
  });
});

describe('curveWindow', () => {
  const yearStart = at('2026-01-01T00:00:00Z');
  const yearEnd = at('2027-01-01T00:00:00Z');

  it('reaches back to the checkpoint before the range and forward to the one after', () => {
    // Without this, the interval closing out December (checkpoint read in
    // January) would have no curve data at its right endpoint and would fall
    // back to a day-count split instead of the smart meter's shape.
    const w = curveWindow(
      [
        checkpoint('2025-12-20T00:00:00Z', 900, 0),
        checkpoint('2026-06-01T00:00:00Z', 1200, 0),
        checkpoint('2027-01-20T00:00:00Z', 1500, 0),
      ],
      yearStart,
      yearEnd,
    );

    expect(w.from).toBe(at('2025-12-20T00:00:00Z'));
    expect(w.to).toBe(at('2027-01-20T00:00:00Z'));
  });

  it('falls back to the range bounds when no checkpoint lies outside it', () => {
    const w = curveWindow([checkpoint('2026-06-01T00:00:00Z', 1200, 0)], yearStart, yearEnd);

    expect(w.from).toBe(yearStart);
    expect(w.to).toBe(yearEnd);
  });

  it('ignores checkpoints inside the range for both bounds', () => {
    const w = curveWindow(
      [
        checkpoint('2026-03-01T00:00:00Z', 1000, 0),
        checkpoint('2026-09-01T00:00:00Z', 1300, 0),
      ],
      yearStart,
      yearEnd,
    );

    expect(w.from).toBe(yearStart);
    expect(w.to).toBe(yearEnd);
  });
});
