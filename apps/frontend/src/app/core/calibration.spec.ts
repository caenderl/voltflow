import { describe, expect, it } from 'vitest';
import type { EnergyBalance, EnergySummary } from '@org/shared-types';
import { calibrateBalance, calibrateEnergy } from './calibration';

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

const balance = (): EnergyBalance => ({
  from: '2026-07-01T00:00:00Z',
  to: '2026-07-02T00:00:00Z',
  productionKwh: 10,
  importKwh: 5,
  exportKwh: 3,
  consumptionKwh: 12,
  selfConsumedKwh: 7,
  selfConsumptionRate: 0.7,
  autarkyRate: 0.5833333333333334,
});

describe('calibrateBalance', () => {
  it('returns null for null balance', () => {
    expect(calibrateBalance(null, { importFactor: 1.02, exportFactor: 0.99 })).toBeNull();
  });

  it('returns the input unchanged when there are no factors', () => {
    const b = balance();
    expect(calibrateBalance(b, null)).toBe(b);
  });

  it('recomputes self-consumption, consumption and the rates from the calibrated import/export', () => {
    // production 10, export 3 * 1.1 = 3.3 -> selfConsumed 6.7; + import 5 * 1.2 = 6 -> consumption 12.7
    const r = calibrateBalance(balance(), { importFactor: 1.2, exportFactor: 1.1 });
    expect(r?.importKwh).toBeCloseTo(6, 6);
    expect(r?.exportKwh).toBeCloseTo(3.3, 6);
    expect(r?.selfConsumedKwh).toBeCloseTo(6.7, 6);
    expect(r?.consumptionKwh).toBeCloseTo(12.7, 6);
    expect(r?.selfConsumptionRate).toBeCloseTo(0.67, 6);
    expect(r?.autarkyRate).toBeCloseTo(6.7 / 12.7, 6);
  });

  it('leaves production untouched — it carries no factor', () => {
    const r = calibrateBalance(balance(), { importFactor: 1.2, exportFactor: 1.1 });
    expect(r?.productionKwh).toBe(10);
  });

  it('clamps self-consumption at 0 when calibrated export exceeds production', () => {
    const r = calibrateBalance(balance(), { importFactor: 1, exportFactor: 5 });
    expect(r?.selfConsumedKwh).toBe(0);
    expect(r?.consumptionKwh).toBe(r?.importKwh);
  });

  it('returns null rates when the denominator is 0', () => {
    const r = calibrateBalance(
      { ...balance(), productionKwh: 0, importKwh: 0, exportKwh: 0 },
      { importFactor: 1.2, exportFactor: 1.1 },
    );
    expect(r?.selfConsumptionRate).toBeNull();
    expect(r?.autarkyRate).toBeNull();
  });

  it('leaves the input object untouched', () => {
    const b = balance();
    calibrateBalance(b, { importFactor: 1.2, exportFactor: 1.1 });
    expect(b.importKwh).toBe(5);
    expect(b.consumptionKwh).toBe(12);
  });
});
