import { describe, expect, it } from 'vitest';
import { rolesForType, rowToDeviceInfo } from './device.mapper';

const row = (over: Record<string, unknown> = {}) => ({
  device_sn: 'SN1',
  device_pn: 'STP 6000TL-20',
  type: 'inverter',
  alias: 'Dach',
  roles: ['producer'],
  created_at: '2026-07-01T10:00:00.000Z',
  ...over,
});

describe('rolesForType', () => {
  it('maps every collector type the project ships', () => {
    expect(rolesForType('smartmeter')).toEqual(['grid-meter']);
    expect(rolesForType('inverter')).toEqual(['producer']);
    expect(rolesForType('wallbox')).toEqual(['consumer']);
  });

  it('yields no role for an unknown or missing type rather than guessing', () => {
    expect(rolesForType('toaster')).toEqual([]);
    expect(rolesForType(null)).toEqual([]);
  });
});

describe('rowToDeviceInfo', () => {
  it('maps a fully populated row', () => {
    const d = rowToDeviceInfo(row());
    expect(d).toEqual({
      deviceSn: 'SN1',
      devicePn: 'STP 6000TL-20',
      type: 'inverter',
      alias: 'Dach',
      roles: ['producer'],
      firstSeen: '2026-07-01T10:00:00.000Z',
    });
  });

  it('prefers the stored roles over the type mapping', () => {
    // A hybrid inverter classified by hand must not be reduced back to
    // whatever its collector type implies.
    const d = rowToDeviceInfo(row({ roles: ['producer', 'storage'] }));
    expect(d.roles).toEqual(['producer', 'storage']);
  });

  it('falls back to the type mapping when roles are null or empty', () => {
    // Rows written before the roles column existed.
    expect(rowToDeviceInfo(row({ roles: null })).roles).toEqual(['producer']);
    expect(rowToDeviceInfo(row({ roles: [] })).roles).toEqual(['producer']);
  });

  it('keeps missing optional columns as null', () => {
    const d = rowToDeviceInfo(row({ device_pn: null, alias: null, type: null, roles: null }));
    expect(d.devicePn).toBeNull();
    expect(d.alias).toBeNull();
    expect(d.type).toBeNull();
    expect(d.roles).toEqual([]);
  });
});
