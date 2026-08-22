import { Injectable } from '@nestjs/common';
import type { WallboxDailySummary, WallboxReading } from '@org/shared-types';
import { TIMEZONE } from '../common/config';
import { MAX_RAW_ROWS, assertNotTruncated } from '../common/db-utils';
import type { HasHistory, HasLatestPerDevice } from '../common/device-capabilities';
import { DbService } from '../database/db.service';
import { rowToWallboxReading } from './wallbox.mapper';

const READING_COLUMNS = `time, device_sn, status, cp_signal, active_power_w,
  session_energy_wh, session_duration_s, energy_wh,
  l1_current_a, l2_current_a, l3_current_a,
  l1_voltage_v, l2_voltage_v, l3_voltage_v`;

@Injectable()
export class WallboxService
  implements HasLatestPerDevice<WallboxReading>, HasHistory<WallboxReading>
{
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

  /**
   * Daily charged energy in [from, to) from the wallbox_1day continuous
   * aggregate (Berlin-timezone day buckets, 10-year retention), summed across
   * devices (the cagg is grouped by device_sn - one row per bucket here).
   * Only days with actual charging activity are returned.
   */
  async dailyEnergy(from: Date, to: Date): Promise<WallboxDailySummary[]> {
    const { rows } = await this.db.query(
      `SELECT
         (bucket AT TIME ZONE $3)::date::text AS day,
         ROUND(sum(charged_kwh)::numeric, 2)  AS charged_kwh
       FROM wallbox_1day
       WHERE bucket >= $1
         AND bucket < $2
       GROUP BY day
       HAVING COALESCE(sum(charged_kwh), 0) > 0
       ORDER BY day`,
      [from, to, TIMEZONE],
    );
    return rows.map((r) => ({
      day: String(r['day']),
      chargedKwh: Number(r['charged_kwh']),
    }));
  }

  /** Raw wallbox readings in [from, to), oldest first. */
  async history(from: Date, to: Date): Promise<WallboxReading[]> {
    const { rows } = await this.db.query(
      `SELECT ${READING_COLUMNS}
         FROM wallbox_reading
        WHERE time >= $1 AND time < $2
        ORDER BY time
        LIMIT ${MAX_RAW_ROWS + 1}`,
      [from, to],
    );
    assertNotTruncated(rows.length, 'wallbox history');
    return rows.map(rowToWallboxReading);
  }
}
