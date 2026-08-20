import { Injectable } from '@nestjs/common';
import type { DeviceInfo } from '@org/shared-types';
import { DbService } from '../database/db.service';
import { rowToDeviceInfo } from './device.mapper';

/**
 * Reads the device registry: which devices have ever reported, and what each
 * one is in energy terms.
 *
 * The `device` table has been written by the collector since the first release
 * but was never read back — every query instead hard-coded "the" meter, "the"
 * inverter. This is the first reader, and the seam the per-instance work
 * (device_config, role-based aggregates) will build on.
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
}
