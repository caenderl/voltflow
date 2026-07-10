import type { EnergyBalance } from '@org/shared-types';
import { round2 } from '../common/db-utils';

/** Raw kWh figures from the DB (PV production + meter import/export deltas). */
export interface EnergyBalanceInputs {
  /** PV energy produced (SMA total_yield delta). */
  production: unknown;
  /** Grid import (meter counter delta). */
  importKwh: unknown;
  /** Grid feed-in / export (meter counter delta). */
  exportKwh: unknown;
}

/**
 * Derive the energy balance for [from, to) from the raw production / import /
 * export figures — pure arithmetic, no DB. Counter deltas can come back
 * slightly negative (counter resets, clock skew) or null (no rows); each input
 * is floored at 0 so the derived quantities stay physical.
 *
 * consumption = selfConsumed + import, where selfConsumed = production − export
 * (PV that never left the house). Rates are null when their denominator is 0.
 */
export function computeEnergyBalance(
  { production, importKwh, exportKwh }: EnergyBalanceInputs,
  from: Date,
  to: Date,
): EnergyBalance {
  const prod = Math.max(0, Number(production ?? 0));
  const imp = Math.max(0, Number(importKwh ?? 0));
  const exp = Math.max(0, Number(exportKwh ?? 0));
  const selfConsumed = Math.max(0, prod - exp);
  const consumption = selfConsumed + imp;

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    productionKwh: round2(prod),
    importKwh: round2(imp),
    exportKwh: round2(exp),
    consumptionKwh: round2(consumption),
    selfConsumedKwh: round2(selfConsumed),
    selfConsumptionRate: prod > 0 ? round2(selfConsumed / prod) : null,
    autarkyRate: consumption > 0 ? round2(selfConsumed / consumption) : null,
  };
}
