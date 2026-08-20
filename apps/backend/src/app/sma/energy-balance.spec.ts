import { describe, expect, it } from 'vitest';
import { computeEnergyBalance } from './energy-balance';

const FROM = new Date('2026-07-01T00:00:00.000Z');
const TO = new Date('2026-07-02T00:00:00.000Z');

const balance = (inputs: {
  production?: unknown;
  importKwh?: unknown;
  exportKwh?: unknown;
  chargedKwh?: unknown;
  dischargedKwh?: unknown;
}) =>
  computeEnergyBalance(
    {
      production: inputs.production,
      importKwh: inputs.importKwh,
      exportKwh: inputs.exportKwh,
      chargedKwh: inputs.chargedKwh,
      dischargedKwh: inputs.dischargedKwh,
    },
    FROM,
    TO,
  );

describe('computeEnergyBalance', () => {
  it('passes the range through as ISO strings', () => {
    const b = balance({ production: 10, importKwh: 5, exportKwh: 3 });
    expect(b.from).toBe(FROM.toISOString());
    expect(b.to).toBe(TO.toISOString());
  });

  it('computes self-consumption, consumption and the rates', () => {
    // production 10, export 3 -> selfConsumed 7; + import 5 -> consumption 12
    const b = balance({ production: 10, importKwh: 5, exportKwh: 3 });
    expect(b.selfConsumedKwh).toBe(7);
    expect(b.consumptionKwh).toBe(12);
    expect(b.selfConsumptionRate).toBe(0.7); // 7 / 10
    expect(b.autarkyRate).toBe(0.58); // 7 / 12, rounded to 2 dp
  });

  it('floors negative / null counter deltas at 0', () => {
    const b = balance({ production: -2, importKwh: null, exportKwh: undefined });
    expect(b.productionKwh).toBe(0);
    expect(b.importKwh).toBe(0);
    expect(b.exportKwh).toBe(0);
    expect(b.consumptionKwh).toBe(0);
  });

  it('clamps self-consumption at 0 when export exceeds production', () => {
    // export can outrun production over a bucket boundary; must not go negative
    const b = balance({ production: 4, importKwh: 1, exportKwh: 6 });
    expect(b.selfConsumedKwh).toBe(0);
    expect(b.consumptionKwh).toBe(1);
  });

  it('returns null rates when the denominator is 0', () => {
    const b = balance({ production: 0, importKwh: 0, exportKwh: 0 });
    expect(b.selfConsumptionRate).toBeNull(); // no PV
    expect(b.autarkyRate).toBeNull(); // no load
  });

  it('coerces numeric strings (pg returns numerics as strings)', () => {
    const b = balance({ production: '10', importKwh: '5', exportKwh: '3' });
    expect(b.productionKwh).toBe(10);
    expect(b.selfConsumedKwh).toBe(7);
  });

  // No storage device exists yet; these pin down the arithmetic so adding one
  // later is a matter of supplying the two figures, not of rethinking the math.
  describe('with a storage device', () => {
    it('is unchanged by zero charge / discharge', () => {
      const withZeros = balance({
        production: 10,
        importKwh: 5,
        exportKwh: 3,
        chargedKwh: 0,
        dischargedKwh: 0,
      });
      expect(withZeros).toEqual(balance({ production: 10, importKwh: 5, exportKwh: 3 }));
    });

    it('does not double-count PV that passed through the battery', () => {
      // 10 kWh PV, 4 of it stored and given back the same day, nothing exported
      // or imported: the house consumed all 10, once.
      const b = balance({
        production: 10,
        importKwh: 0,
        exportKwh: 0,
        chargedKwh: 4,
        dischargedKwh: 4,
      });
      expect(b.consumptionKwh).toBe(10);
      expect(b.selfConsumedKwh).toBe(10);
      expect(b.autarkyRate).toBe(1);
    });

    it('keeps grid-charged energy out of self-consumption', () => {
      // No sun: 5 kWh imported into the battery and later used by the house.
      const b = balance({
        production: 0,
        importKwh: 5,
        exportKwh: 0,
        chargedKwh: 5,
        dischargedKwh: 5,
      });
      expect(b.consumptionKwh).toBe(5);
      expect(b.selfConsumedKwh).toBe(0);
      expect(b.autarkyRate).toBe(0);
    });

    it('caps self-consumption when the battery ends the range fuller', () => {
      // 10 kWh PV, 4 still in the battery at the end -> the load was only 6,
      // and the rates must not exceed 100 %.
      const b = balance({
        production: 10,
        importKwh: 0,
        exportKwh: 0,
        chargedKwh: 4,
        dischargedKwh: 0,
      });
      expect(b.consumptionKwh).toBe(6);
      expect(b.selfConsumedKwh).toBe(6);
      expect(b.autarkyRate).toBe(1);
      expect(b.selfConsumptionRate).toBe(0.6);
    });

    it('counts discharge with no matching import as self-consumed', () => {
      // No production, no grid import: the 5 kWh the house used can only have
      // come out of the battery, so the house was fully autark this period -
      // even though none of it was produced in the window itself.
      const b = balance({
        production: 0,
        importKwh: 0,
        exportKwh: 0,
        chargedKwh: 0,
        dischargedKwh: 5,
      });
      expect(b.consumptionKwh).toBe(5);
      expect(b.selfConsumedKwh).toBe(5);
      expect(b.autarkyRate).toBe(1);
    });
  });
});
