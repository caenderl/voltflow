import type { EnergyBalance, EnergySummary } from '@org/shared-types';

/** Per-direction correction factors (physical / smart), from the reconciliation. */
export interface CalibrationFactors {
  importFactor: number;
  exportFactor: number;
}

/**
 * Scale a smart-meter energy summary onto the physical meter using the
 * checkpoint reconciliation's correction factors.
 *
 * `factors` null — calibration is off, or there is no comparable checkpoint pair
 * to derive a factor from — returns the input unchanged. Only grid import/export
 * is corrected; PV production and wallbox charging are not grid-meter quantities
 * and carry no factor. Values are left unrounded: the number pipe and the chart
 * round for display, so no precision is invented here.
 */
export function calibrateEnergy(
  energy: EnergySummary | null,
  factors: CalibrationFactors | null,
): EnergySummary | null {
  if (!energy || !factors) return energy;
  const { importFactor, exportFactor } = factors;
  return {
    ...energy,
    importKwh: energy.importKwh * importFactor,
    exportKwh: energy.exportKwh * exportFactor,
    buckets: energy.buckets.map((b) => ({
      ...b,
      importKwh: b.importKwh * importFactor,
      exportKwh: b.exportKwh * exportFactor,
    })),
  };
}

/**
 * Recompute an energy balance's grid-derived figures (self-consumption,
 * consumption, the rates) from calibrated import/export, mirroring the
 * backend's `computeEnergyBalance`. Production is left as measured — it
 * carries no factor. Without this, a view showing calibrated Bezug/Einspeisung
 * next to this balance's Autarkie/Eigenverbrauch/Hauslast would have the two
 * disagree, since those are derived from the raw import/export otherwise.
 */
export function calibrateBalance(
  balance: EnergyBalance | null,
  factors: CalibrationFactors | null,
): EnergyBalance | null {
  if (!balance || !factors) return balance;
  const { importFactor, exportFactor } = factors;
  const importKwh = balance.importKwh * importFactor;
  const exportKwh = balance.exportKwh * exportFactor;
  const selfConsumedKwh = Math.max(0, balance.productionKwh - exportKwh);
  const consumptionKwh = selfConsumedKwh + importKwh;
  return {
    ...balance,
    importKwh,
    exportKwh,
    selfConsumedKwh,
    consumptionKwh,
    selfConsumptionRate: balance.productionKwh > 0 ? selfConsumedKwh / balance.productionKwh : null,
    autarkyRate: consumptionKwh > 0 ? selfConsumedKwh / consumptionKwh : null,
  };
}
