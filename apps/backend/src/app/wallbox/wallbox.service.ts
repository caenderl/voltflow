import { Injectable } from '@nestjs/common';
import type { WallboxReading } from '@org/shared-types';
import type { HasLatestPerDevice } from '../common/device-capabilities';
import { DbService } from '../database/db.service';
import { rowToWallboxReading } from './wallbox.mapper';

const READING_COLUMNS = `time, device_sn, status, cp_signal, active_power_w,
  session_energy_wh, session_duration_s, energy_wh,
  l1_current_a, l2_current_a, l3_current_a,
  l1_voltage_v, l2_voltage_v, l3_voltage_v`;

/**
 * The wallboxes' own live readings — charging status, CP signal, session
 * counters, per-phase values. The charged-energy figures are a consumer-role
 * question and live in EnergyService.
 */
@Injectable()
export class WallboxService implements HasLatestPerDevice<WallboxReading> {
  constructor(private readonly db: DbService) {}

  /** Last reading of every wallbox — see {@link SmaService.latestPerDevice}. */
  async latestPerDevice(): Promise<WallboxReading[]> {
    const { rows } = await this.db.query(
      `SELECT DISTINCT ON (device_sn) ${READING_COLUMNS}
         FROM wallbox_reading
        ORDER BY device_sn, time DESC`,
    );
    return rows.map(rowToWallboxReading);
  }
}
