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
  /**
   * Energy that went INTO a storage device over the range. Optional: there is
   * no storage device yet, and 0 reproduces the storage-free balance exactly.
   */
  chargedKwh?: unknown;
  /** Energy that came OUT of a storage device over the range. */
  dischargedKwh?: unknown;
}

/**
 * Derive the energy balance for [from, to) from the raw production / import /
 * export figures — pure arithmetic, no DB. Counter deltas can come back
 * slightly negative (counter resets, clock skew) or null (no rows); each input
 * is floored at 0 so the derived quantities stay physical.
 *
 * The house is a node: what flows in (production + import + discharge)
 * leaves again as export, charge, or household load, so
 *
 *   consumption  = production − export + import + discharge − charge
 *   selfConsumed = production − export   (PV that never left the house)
 *
 * With no storage both extra terms are 0 and this is the original
 * `consumption = selfConsumed + import`. Rates are null when their
 * denominator is 0.
 *
 * selfConsumed is everything in consumption that is not grid import, i.e.
 * `consumption − import` — never negative, since consumption already has the
 * import term added in. That also folds in a battery correctly on both
 * sides: energy discharged without a matching import counts as self-consumed
 * (it must have come from PV, stored earlier), and energy that went into the
 * battery but has not come back out yet is excluded from both consumption
 * and selfConsumed until the period it is actually used — the same boundary
 * effect the grid counter deltas already have.
 */
export function computeEnergyBalance(
  {
    production,
    importKwh,
    exportKwh,
    chargedKwh,
    dischargedKwh,
  }: EnergyBalanceInputs,
  from: Date,
  to: Date,
): EnergyBalance {
  const prod = Math.max(0, Number(production ?? 0));
  const imp = Math.max(0, Number(importKwh ?? 0));
  const exp = Math.max(0, Number(exportKwh ?? 0));
  const charged = Math.max(0, Number(chargedKwh ?? 0));
  const discharged = Math.max(0, Number(dischargedKwh ?? 0));
  const fromPv = Math.max(0, prod - exp);
  const consumption = Math.max(0, fromPv + imp + discharged - charged);
  const selfConsumed = Math.max(0, consumption - imp);

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
