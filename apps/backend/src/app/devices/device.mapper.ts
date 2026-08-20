import type { DeviceInfo, DeviceRole } from '@org/shared-types';

/** The roles every known collector type implies, used to fill in a gap. */
const ROLES_BY_TYPE: Record<string, DeviceRole[]> = {
  smartmeter: ['grid-meter'],
  inverter: ['producer'],
  wallbox: ['consumer'],
};

/**
 * Roles for a device whose `roles` column is empty — a row written by a
 * collector older than the column, or a type nobody has classified yet.
 *
 * The mapping is duplicated in the collector (which seeds the column on first
 * registration) on purpose: this side must still answer for rows that predate
 * that, and an unknown type yields no roles rather than a guess.
 */
export function rolesForType(type: string | null): DeviceRole[] {
  return type ? (ROLES_BY_TYPE[type] ?? []) : [];
}

/** Converts a DB row (snake_case) into a DeviceInfo. */
export function rowToDeviceInfo(row: Record<string, unknown>): DeviceInfo {
  const stored = row['roles'] as string[] | null;
  const type = (row['type'] as string | null) ?? null;
  return {
    deviceSn: row['device_sn'] as string,
    devicePn: (row['device_pn'] as string | null) ?? null,
    type,
    alias: (row['alias'] as string | null) ?? null,
    roles: stored?.length ? (stored as DeviceRole[]) : rolesForType(type),
    firstSeen: new Date(row['created_at'] as string).toISOString(),
  };
}
