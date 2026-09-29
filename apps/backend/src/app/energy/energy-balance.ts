import { type EnergyBalance, deriveEnergyBalance } from '@org/shared-types';
import { round2 } from '../common/db-utils';

/** Raw kWh figures from the DB (PV production + meter import/export deltas). */
export interface EnergyBalanceInputs {
  /** PV energy produced (the producer ledger's sum). */
  production: unknown;
  /** Grid import (the grid ledger's sum). */
  importKwh: unknown;
  /** Grid feed-in / export (the grid ledger's sum). */
  exportKwh: unknown;
  /**
   * Energy that went INTO a storage device over the range. Optional: there is
   * no storage device yet, and 0 reproduces the storage-free balance exactly.
   */
  chargedKwh?: unknown;
  /** Energy that came OUT of a storage device over the range. */
  dischargedKwh?: unknown;
}

/**
 * The energy balance for [from, to) from the DB's raw figures: pg hands back
 * numeric strings or NULL (no rows), which become numbers (NULL -> 0) here;
 * the arithmetic itself is {@link deriveEnergyBalance}, shared with the
 * frontend's calibration so the two cannot drift apart. Rounded for the API.
 */
export function computeEnergyBalance(
  { production, importKwh, exportKwh, chargedKwh, dischargedKwh }: EnergyBalanceInputs,
  from: Date,
  to: Date,
): EnergyBalance {
  const b = deriveEnergyBalance({
    productionKwh: Number(production ?? 0),
    importKwh: Number(importKwh ?? 0),
    exportKwh: Number(exportKwh ?? 0),
    chargedKwh: Number(chargedKwh ?? 0),
    dischargedKwh: Number(dischargedKwh ?? 0),
  });
  const rate = (r: number | null): number | null => (r === null ? null : round2(r));

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    productionKwh: round2(b.productionKwh),
    importKwh: round2(b.importKwh),
    exportKwh: round2(b.exportKwh),
    consumptionKwh: round2(b.consumptionKwh),
    selfConsumedKwh: round2(b.selfConsumedKwh),
    selfConsumptionRate: rate(b.selfConsumptionRate),
    autarkyRate: rate(b.autarkyRate),
  };
}
