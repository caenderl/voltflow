import { Injectable } from '@nestjs/common';
import type {
  DataRange,
  WallboxConfig,
  WallboxDailySummary,
  WallboxReading,
} from '@org/shared-types';
import { TIMEZONE } from '../common/config';
import { toDataRange } from '../common/db-utils';
import {
  SingletonConfigStore,
  asBool,
  asNumber,
  asStringOrNull,
} from '../common/singleton-config';
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
  session_energy_wh, session_duration_s,
  l1_current_a, l2_current_a, l3_current_a,
  l1_voltage_v, l2_voltage_v, l3_voltage_v`;

@Injectable()
export class WallboxService {
  private readonly config: SingletonConfigStore<WallboxConfig>;

  constructor(private readonly db: DbService) {
    this.config = new SingletonConfigStore<WallboxConfig>(
      db,
      'wallbox_config',
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

  async latest(): Promise<WallboxReading | null> {
    const { rows } = await this.db.query(
      `SELECT ${READING_COLUMNS}
         FROM wallbox_reading
        ORDER BY time DESC
        LIMIT 1`,
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
   * aggregate (Berlin-timezone day buckets, 10-year retention).
   * Only days with actual charging activity are returned.
   */
  async dailyEnergy(from: Date, to: Date): Promise<WallboxDailySummary[]> {
    const { rows } = await this.db.query(
      `SELECT
         (bucket AT TIME ZONE $3)::date::text AS day,
         ROUND(charged_kwh::numeric, 2)       AS charged_kwh
       FROM wallbox_1day
       WHERE bucket >= $1
         AND bucket < $2
         AND COALESCE(charged_kwh, 0) > 0
       ORDER BY bucket`,
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
        ORDER BY time`,
      [from, to],
    );
    return rows.map(rowToWallboxReading);
  }
}
