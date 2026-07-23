import type { EnergySummary } from '@org/shared-types';

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
