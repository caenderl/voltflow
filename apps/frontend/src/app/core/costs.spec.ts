import { describe, expect, it } from 'vitest';
import type { EnergyBucket, EnergySummary, TariffPeriod } from '@org/shared-types';
import { computeCosts } from './costs';

const period = (
  id: number,
  validFrom: string,
  importCtPerKwh: number | null = 30,
  exportCtPerKwh: number | null = 8,
): TariffPeriod => ({ id, validFrom, provider: `T${id}`, importCtPerKwh, exportCtPerKwh });

// Noon UTC so the bucket's local day equals its UTC day in any western TZ.
const bucket = (day: string, importKwh: number, exportKwh: number): EnergyBucket => ({
  time: `${day}T12:00:00Z`,
  importKwh,
  exportKwh,
});

const energy = (
  importKwh: number,
  exportKwh: number,
  buckets: EnergyBucket[],
): EnergySummary => ({
  period: 'month',
  from: '2026-07-01T00:00:00Z',
  to: '2026-08-01T00:00:00Z',
  importKwh,
  exportKwh,
  buckets,
});

describe('computeCosts', () => {
  it('returns null without energy or without periods', () => {
    expect(computeCosts(null, [period(1, '2026-01-01')])).toBeNull();
    expect(computeCosts(energy(100, 200, []), [])).toBeNull();
  });

  it('bills the exact range totals when one priced tariff covers everything', () => {
    // Buckets deliberately sum to less than the totals (gaps): the exact path
    // must bill the 100/200 totals, not the 99/200 the buckets add up to.
    const e = energy(100, 200, [
      bucket('2026-07-01', 40, 80),
      bucket('2026-07-02', 59, 120),
    ]);
    const c = computeCosts(e, [period(1, '2026-01-01', 30, 8)]);
    expect(c?.importCost).toBeCloseTo(30, 6); // 100 * 30ct
    expect(c?.exportRevenue).toBeCloseTo(16, 6); // 200 * 8ct
    expect(c?.net).toBeCloseTo(14, 6);
  });

  it('splits per bucket across a tariff change', () => {
    const e = energy(50, 15, [
      bucket('2026-07-01', 10, 5), // old tariff 30/8
      bucket('2026-07-02', 20, 5), // new tariff 40/10
      bucket('2026-07-03', 20, 5), // new tariff 40/10
    ]);
    const c = computeCosts(e, [period(1, '2026-01-01', 30, 8), period(2, '2026-07-02', 40, 10)]);
    // import: 10*0.30 + 20*0.40 + 20*0.40 = 19; export: 5*0.08 + 5*0.10 + 5*0.10 = 1.4
    expect(c?.importCost).toBeCloseTo(19, 6);
    expect(c?.exportRevenue).toBeCloseTo(1.4, 6);
  });

  it('applies the oldest tariff to data that predates it (backward extension)', () => {
    // validFrom is after every bucket, yet the period still prices them.
    const e = energy(30, 10, [bucket('2026-07-01', 10, 5), bucket('2026-07-02', 20, 5)]);
    const c = computeCosts(e, [period(1, '2026-07-15', 30, 8)]);
    expect(c?.importCost).toBeCloseTo(9, 6); // exact path: 30 * 30ct
    expect(c?.exportRevenue).toBeCloseTo(0.8, 6);
  });

  it('returns null when the only applicable tariff has no prices', () => {
    const e = energy(100, 200, [bucket('2026-07-01', 100, 200)]);
    expect(computeCosts(e, [period(1, '2026-01-01', null, null)])).toBeNull();
  });

  it('excludes buckets whose tariff has no prices instead of billing the totals', () => {
    // Earliest period unpriced, later priced; only the priced bucket counts, and
    // the exact-totals shortcut must stay off because a bucket was skipped.
    const e = energy(30, 10, [
      bucket('2026-07-01', 10, 5), // unpriced period -> skipped
      bucket('2026-07-02', 20, 5), // priced 40/10
    ]);
    const c = computeCosts(e, [period(1, '2026-01-01', null, null), period(2, '2026-07-02', 40, 10)]);
    expect(c?.importCost).toBeCloseTo(8, 6); // only 20 * 0.40, not 30 * 0.40
    expect(c?.exportRevenue).toBeCloseTo(0.5, 6);
  });
});
