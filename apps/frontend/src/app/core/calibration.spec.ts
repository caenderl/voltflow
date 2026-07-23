import { describe, expect, it } from 'vitest';
import type { EnergySummary } from '@org/shared-types';
import { calibrateEnergy } from './calibration';

const summary = (): EnergySummary => ({
  period: 'week',
  from: '2026-07-01T00:00:00Z',
  to: '2026-07-08T00:00:00Z',
  importKwh: 100,
  exportKwh: 200,
  buckets: [
    { time: '2026-07-01T00:00:00Z', importKwh: 40, exportKwh: 80 },
    { time: '2026-07-02T00:00:00Z', importKwh: 60, exportKwh: 120 },
  ],
});

describe('calibrateEnergy', () => {
  it('returns null for null energy', () => {
    expect(calibrateEnergy(null, { importFactor: 1.02, exportFactor: 0.99 })).toBeNull();
  });

  it('returns the input unchanged when there are no factors', () => {
    const e = summary();
    // Same reference: no factor means nothing to calibrate, not a needless copy.
    expect(calibrateEnergy(e, null)).toBe(e);
  });

  it('scales totals and every bucket by the matching direction factor', () => {
    const r = calibrateEnergy(summary(), { importFactor: 1.02, exportFactor: 0.99 });
    expect(r?.importKwh).toBeCloseTo(102, 6);
    expect(r?.exportKwh).toBeCloseTo(198, 6);
    expect(r?.buckets[0]).toMatchObject({ importKwh: 40 * 1.02, exportKwh: 80 * 0.99 });
    expect(r?.buckets[1]).toMatchObject({ importKwh: 60 * 1.02, exportKwh: 120 * 0.99 });
  });

  it('does not cross the factors between import and export', () => {
    // Import scaled up, export scaled down — a swapped factor would move them
    // the wrong way, which this asymmetric pair would catch.
    const r = calibrateEnergy(summary(), { importFactor: 2, exportFactor: 0.5 });
    expect(r?.importKwh).toBe(200);
    expect(r?.exportKwh).toBe(100);
  });

  it('leaves the input object untouched', () => {
    const e = summary();
    calibrateEnergy(e, { importFactor: 1.02, exportFactor: 0.99 });
    expect(e.importKwh).toBe(100);
    expect(e.buckets[0].importKwh).toBe(40);
  });
});
