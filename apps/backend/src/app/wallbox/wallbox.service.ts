import { Injectable } from '@nestjs/common';
import type {
  DataRange,
  WallboxConfig,
  WallboxDailySummary,
  WallboxHourlySummary,
  WallboxReading,
} from '@org/shared-types';
import { TIMEZONE } from '../common/config';
import { MAX_RAW_ROWS, assertNotTruncated, toDataRange } from '../common/db-utils';
import type {
  Configurable,
  HasHistory,
  HasLatest,
  HasRange,
} from '../common/device-capabilities';
import {
  DriverConfigStore,
  asBool,
  asNumber,
  asStringOrNull,
} from '../common/config-store';
import { DbService } from '../database/db.service';
import { rowToWallboxReading } from './wallbox.mapper';

const DEFAULT_CONFIG: WallboxConfig = {
  enabled: false,
  name: null,
  host: null,
  port: 502,
  unitId: 1,
  pollIntervalS: 30,
};

const READING_COLUMNS = `time, device_sn, status, cp_signal, active_power_w,
  session_energy_wh, session_duration_s, energy_wh,
  l1_current_a, l2_current_a, l3_current_a,
  l1_voltage_v, l2_voltage_v, l3_voltage_v`;

@Injectable()
export class WallboxService
  implements
    HasLatest<WallboxReading>,
    HasRange,
    HasHistory<WallboxReading>,
    Configurable<WallboxConfig>
{
  private readonly config: DriverConfigStore<WallboxConfig>;

  constructor(private readonly db: DbService) {
    this.config = new DriverConfigStore<WallboxConfig>(
      db,
      'anker-v1-modbus',
      [
        { column: 'enabled', key: 'enabled', fromDb: asBool },
        { column: 'name', key: 'name', fromDb: asStringOrNull },
        { column: 'host', key: 'host', fromDb: asStringOrNull },
        { column: 'port', key: 'port', fromDb: asNumber },
        { column: 'unit_id', key: 'unitId', fromDb: asNumber },
        { column: 'poll_interval_s', key: 'pollIntervalS', fromDb: asNumber },
      ],
      DEFAULT_CONFIG,
    );
  }

  getConfig(): Promise<WallboxConfig> {
    return this.config.get();
  }

  saveConfig(c: WallboxConfig): Promise<WallboxConfig> {
    return this.config.save(c);
  }

  async latest(deviceSn?: string): Promise<WallboxReading | null> {
    const { rows } = await this.db.query(
      `SELECT ${READING_COLUMNS}
         FROM wallbox_reading
        WHERE ($1::text IS NULL OR device_sn = $1)
        ORDER BY time DESC
        LIMIT 1`,
      [deviceSn || null],
    );
    return rows.length ? rowToWallboxReading(rows[0]) : null;
  }

  async range(): Promise<DataRange> {
    const { rows } = await this.db.query(
      `SELECT min(time) AS first, max(time) AS last FROM wallbox_reading`,
    );
    return toDataRange(rows[0]);
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

  /**
   * Hourly charged energy in [from, to) from the wallbox_1hour continuous
   * aggregate, summed across devices (the cagg is grouped by device_sn).
   * Only hours with actual charging activity are returned.
   */
  async hourlyEnergy(from: Date, to: Date): Promise<WallboxHourlySummary[]> {
    const { rows } = await this.db.query(
      `SELECT
         bucket,
         ROUND(sum(charged_kwh)::numeric, 2) AS charged_kwh
       FROM wallbox_1hour
       WHERE bucket >= $1
         AND bucket < $2
       GROUP BY bucket
       HAVING COALESCE(sum(charged_kwh), 0) > 0
       ORDER BY bucket`,
      [from, to],
    );
    return rows.map((r) => ({
      time: new Date(r['bucket'] as string).toISOString(),
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
