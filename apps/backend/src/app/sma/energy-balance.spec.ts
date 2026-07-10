import { describe, expect, it } from 'vitest';
import { computeEnergyBalance } from './energy-balance';

const FROM = new Date('2026-07-01T00:00:00.000Z');
const TO = new Date('2026-07-02T00:00:00.000Z');

const balance = (inputs: {
  production?: unknown;
  importKwh?: unknown;
  exportKwh?: unknown;
}) =>
  computeEnergyBalance(
    { production: inputs.production, importKwh: inputs.importKwh, exportKwh: inputs.exportKwh },
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
});
