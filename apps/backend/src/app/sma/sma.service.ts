import { Injectable } from '@nestjs/common';
import type {
  DataRange,
  EnergyBalance,
  HouseLoadPoint,
  SmaConfig,
  SmaDailySummary,
  SmaReading,
} from '@org/shared-types';
import { DbService, rowToSmaReading } from '../database/db.service';

const TIMEZONE = process.env.TZ || 'Europe/Berlin';

const DEFAULT_CONFIG: SmaConfig = {
  enabled: false,
  name: null,
  host: null,
  pollIntervalS: 60,
};

const READING_COLUMNS = `time, device_sn, asleep, grid_power, pv_power_a, pv_power_b,
  daily_yield_wh, total_yield_kwh, power_l1, power_l2, power_l3,
  pv_voltage_a, pv_voltage_b, pv_current_a, pv_current_b,
  voltage_l1, voltage_l2, voltage_l3, frequency, temp_a, status`;

@Injectable()
export class SmaService {
  constructor(private readonly db: DbService) {}

  async getConfig(): Promise<SmaConfig> {
    const { rows } = await this.db.query(
      `SELECT enabled, name, host, poll_interval_s FROM sma_config WHERE id = 1`,
    );
    if (!rows.length) return { ...DEFAULT_CONFIG };
    const r = rows[0];
    return {
      enabled: Boolean(r['enabled']),
      name: (r['name'] as string) ?? null,
      host: (r['host'] as string) ?? null,
      pollIntervalS: Number(r['poll_interval_s']),
    };
  }

  async saveConfig(c: SmaConfig): Promise<SmaConfig> {
    await this.db.query(
      `INSERT INTO sma_config (id, enabled, name, host, poll_interval_s, updated_at)
       VALUES (1, $1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             name = EXCLUDED.name,
             host = EXCLUDED.host,
             poll_interval_s = EXCLUDED.poll_interval_s,
             updated_at = now()`,
      [c.enabled, c.name, c.host, c.pollIntervalS],
    );
    return this.getConfig();
  }

  async latest(): Promise<SmaReading | null> {
    const { rows } = await this.db.query(
      `SELECT ${READING_COLUMNS} FROM sma_readings ORDER BY time DESC LIMIT 1`,
    );
    return rows.length ? rowToSmaReading(rows[0]) : null;
  }

  async range(): Promise<DataRange> {
    const { rows } = await this.db.query(
      `SELECT min(time) AS first, max(time) AS last FROM sma_readings`,
    );
    const r = rows[0] ?? {};
    return {
      first: r['first'] ? new Date(r['first'] as string).toISOString() : null,
      last: r['last'] ? new Date(r['last'] as string).toISOString() : null,
    };
  }

  /** Raw SMA readings in [from, to), oldest first. */
  async history(from: Date, to: Date): Promise<SmaReading[]> {
    const { rows } = await this.db.query(
      `SELECT ${READING_COLUMNS}
         FROM sma_readings
        WHERE time >= $1 AND time < $2
        ORDER BY time`,
      [from, to],
    );
    return rows.map(rowToSmaReading);
  }

  /** Daily PV yield per day (from the sma_1day continuous aggregate). */
  async dailyEnergy(from: Date, to: Date): Promise<SmaDailySummary[]> {
    const { rows } = await this.db.query(
      `SELECT (bucket AT TIME ZONE $3)::date::text AS day,
              ROUND((daily_yield_wh / 1000.0)::numeric, 2) AS yield_kwh
         FROM sma_1day
        WHERE bucket >= $1 AND bucket < $2
          AND COALESCE(daily_yield_wh, 0) > 0
        ORDER BY bucket`,
      [from, to, TIMEZONE],
    );
    return rows.map((r) => ({
      day: String(r['day']),
      yieldKwh: Number(r['yield_kwh']),
    }));
  }

  /** Derived house-load series on the common 1-min grid (meter + SMA). */
  async houseLoad(from: Date, to: Date): Promise<HouseLoadPoint[]> {
    const { rows } = await this.db.query(
      `SELECT bucket, house_power, pv_power
         FROM house_load_1min
        WHERE bucket >= $1 AND bucket < $2
        ORDER BY bucket`,
      [from, to],
    );
    return rows.map((r) => ({
      time: new Date(r['bucket'] as string).toISOString(),
      housePower: numOrNull(r['house_power']),
      pvPower: numOrNull(r['pv_power']),
    }));
  }

  /**
   * Energy balance over [from, to): PV production (SMA total_yield delta) vs.
   * grid import/export (meter counter deltas), yielding self-consumption and
   * self-sufficiency (autarky).
   */
  async balance(from: Date, to: Date): Promise<EnergyBalance> {
    const { rows: pv } = await this.db.query(
      `SELECT max(total_yield_kwh) - min(total_yield_kwh) AS production_kwh
         FROM sma_readings
        WHERE time >= $1 AND time < $2`,
      [from, to],
    );
    const { rows: grid } = await this.db.query(
      `SELECT max(grid_import_energy) - min(grid_import_energy) AS import_kwh,
              max(grid_export_energy) - min(grid_export_energy) AS export_kwh
         FROM meter_reading
        WHERE time >= $1 AND time < $2`,
      [from, to],
    );

    const production = Math.max(0, Number(pv[0]?.['production_kwh'] ?? 0));
    const importKwh = Math.max(0, Number(grid[0]?.['import_kwh'] ?? 0));
    const exportKwh = Math.max(0, Number(grid[0]?.['export_kwh'] ?? 0));
    const selfConsumed = Math.max(0, production - exportKwh);
    const consumption = selfConsumed + importKwh;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      productionKwh: round2(production),
      importKwh: round2(importKwh),
      exportKwh: round2(exportKwh),
      consumptionKwh: round2(consumption),
      selfConsumedKwh: round2(selfConsumed),
      selfConsumptionRate: production > 0 ? round2(selfConsumed / production) : null,
      autarkyRate: consumption > 0 ? round2(selfConsumed / consumption) : null,
    };
  }
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
