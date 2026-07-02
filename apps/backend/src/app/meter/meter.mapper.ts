import type { MeterReading } from '@org/shared-types';
import { numOrNull } from '../common/db-utils';

/** Converts a DB row (snake_case) into a MeterReading. */
export function rowToReading(row: Record<string, unknown>): MeterReading {
  return {
    time: new Date(row['time'] as string).toISOString(),
    deviceSn: row['device_sn'] as string,
    gridToHomePower: numOrNull(row['grid_to_home_power']),
    pvToGridPower: numOrNull(row['pv_to_grid_power']),
    gridImportEnergy: numOrNull(row['grid_import_energy']),
    gridExportEnergy: numOrNull(row['grid_export_energy']),
  };
}
