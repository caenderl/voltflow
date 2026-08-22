import { Injectable, NotFoundException } from '@nestjs/common';
import type { DeviceInfo, DeviceRole } from '@org/shared-types';
import { DbService } from '../database/db.service';
import { rowToDeviceInfo } from './device.mapper';

/**
 * Reads the device registry: which devices have ever reported, and what each
 * one is in energy terms.
 *
 * The `device` table has been written by the collector since the first release
 * but was never read back — every query instead hard-coded "the" meter, "the"
 * inverter. It is now the seam the per-instance work (device_config,
 * role-based aggregates) is built on, and `roles` is the single value every
 * one of those aggregates filters by.
 */
@Injectable()
export class DevicesService {
  constructor(private readonly db: DbService) {}

  /** All registered devices, oldest registration first. */
  async list(): Promise<DeviceInfo[]> {
    const { rows } = await this.db.query(
      `SELECT device_sn, device_pn, type, alias, roles, created_at
         FROM device
        ORDER BY created_at, device_sn`,
    );
    return rows.map(rowToDeviceInfo);
  }

  /**
   * Set a device's roles — the only writer besides the collector's first-contact
   * seeding, which never overwrites what is already stored.
   *
   * This is the one place a wrong classification can be corrected. Until it
   * existed, a device the collector could not map (an unknown `type`, or a
   * hybrid that is both producer and storage) simply contributed nothing to the
   * house load and the statistics, silently, with no way to see it let alone
   * fix it.
   */
  async setRoles(deviceSn: string, roles: DeviceRole[]): Promise<DeviceInfo> {
    const { rows } = await this.db.query(
      `UPDATE device SET roles = $2::TEXT[]
        WHERE device_sn = $1
        RETURNING device_sn, device_pn, type, alias, roles, created_at`,
      [deviceSn, roles],
    );
    if (!rows.length) throw new NotFoundException(`device ${deviceSn} not found`);
    return rowToDeviceInfo(rows[0]);
  }
}
