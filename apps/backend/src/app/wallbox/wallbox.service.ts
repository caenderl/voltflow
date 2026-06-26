import { Injectable } from '@nestjs/common';
import type {
  DataRange,
  WallboxConfig,
  WallboxDailySummary,
  WallboxReading,
} from '@org/shared-types';
import { DbService, rowToWallboxReading } from '../database/db.service';

const TIMEZONE = process.env.TZ || 'Europe/Berlin';

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
  constructor(private readonly db: DbService) {}

  async getConfig(): Promise<WallboxConfig> {
    const { rows } = await this.db.query(
      `SELECT enabled, name, host, port, unit_id, poll_interval_s
         FROM wallbox_config WHERE id = 1`,
    );
    if (!rows.length) return { ...DEFAULT_CONFIG };
    const r = rows[0];
    return {
      enabled: Boolean(r['enabled']),
      name: (r['name'] as string) ?? null,
      host: (r['host'] as string) ?? null,
      port: Number(r['port']),
      unitId: Number(r['unit_id']),
      pollIntervalS: Number(r['poll_interval_s']),
    };
  }

  async saveConfig(c: WallboxConfig): Promise<WallboxConfig> {
    await this.db.query(
      `INSERT INTO wallbox_config (id, enabled, name, host, port, unit_id, poll_interval_s, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             name = EXCLUDED.name,
             host = EXCLUDED.host,
             port = EXCLUDED.port,
             unit_id = EXCLUDED.unit_id,
             poll_interval_s = EXCLUDED.poll_interval_s,
             updated_at = now()`,
      [c.enabled, c.name, c.host, c.port, c.unitId, c.pollIntervalS],
    );
    return this.getConfig();
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
    const r = rows[0] ?? {};
    return {
      first: r['first'] ? new Date(r['first'] as string).toISOString() : null,
      last: r['last'] ? new Date(r['last'] as string).toISOString() : null,
    };
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
