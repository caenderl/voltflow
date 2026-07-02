import type { SmaReading } from '@org/shared-types';
import { numOrNull } from '../common/db-utils';

/** Converts a DB row (snake_case) into an SmaReading. */
export function rowToSmaReading(row: Record<string, unknown>): SmaReading {
  return {
    time: new Date(row['time'] as string).toISOString(),
    deviceSn: row['device_sn'] as string,
    asleep: Boolean(row['asleep']),
    gridPower: numOrNull(row['grid_power']),
    pvPowerA: numOrNull(row['pv_power_a']),
    pvPowerB: numOrNull(row['pv_power_b']),
    dailyYieldWh: numOrNull(row['daily_yield_wh']),
    totalYieldKwh: numOrNull(row['total_yield_kwh']),
    powerL1: numOrNull(row['power_l1']),
    powerL2: numOrNull(row['power_l2']),
    powerL3: numOrNull(row['power_l3']),
    pvVoltageA: numOrNull(row['pv_voltage_a']),
    pvVoltageB: numOrNull(row['pv_voltage_b']),
    pvCurrentA: numOrNull(row['pv_current_a']),
    pvCurrentB: numOrNull(row['pv_current_b']),
    voltageL1: numOrNull(row['voltage_l1']),
    voltageL2: numOrNull(row['voltage_l2']),
    voltageL3: numOrNull(row['voltage_l3']),
    frequency: numOrNull(row['frequency']),
    tempA: numOrNull(row['temp_a']),
    status: numOrNull(row['status']),
  };
}
