import type { WallboxReading } from '@org/shared-types';
import { numOrNull } from '../common/db-utils';

/** Converts a DB row (snake_case) into a WallboxReading. */
export function rowToWallboxReading(row: Record<string, unknown>): WallboxReading {
  return {
    time: new Date(row['time'] as string).toISOString(),
    deviceSn: row['device_sn'] as string,
    status: numOrNull(row['status']),
    cpSignal: numOrNull(row['cp_signal']),
    activePowerW: numOrNull(row['active_power_w']),
    sessionEnergyWh: numOrNull(row['session_energy_wh']),
    sessionDurationS: numOrNull(row['session_duration_s']),
    l1CurrentA: numOrNull(row['l1_current_a']),
    l2CurrentA: numOrNull(row['l2_current_a']),
    l3CurrentA: numOrNull(row['l3_current_a']),
    l1VoltageV: numOrNull(row['l1_voltage_v']),
    l2VoltageV: numOrNull(row['l2_voltage_v']),
    l3VoltageV: numOrNull(row['l3_voltage_v']),
  };
}
