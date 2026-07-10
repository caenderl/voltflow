import { Injectable } from '@nestjs/common';
import type {
  DataRange,
  EnergyBalance,
  HouseLoadPoint,
  SmaConfig,
  SmaDailySummary,
  SmaMinutePower,
  SmaReading,
} from '@org/shared-types';
import { TIMEZONE } from '../common/config';
import { numOrNull, toDataRange } from '../common/db-utils';
import type {
  Configurable,
  HasHistory,
  HasLatest,
  HasRange,
} from '../common/device-capabilities';
import {
  SingletonConfigStore,
  asBool,
  asNumber,
  asStringOrNull,
} from '../common/singleton-config';
import { DbService } from '../database/db.service';
import { computeEnergyBalance } from './energy-balance';
import { rowToSmaReading } from './sma.mapper';

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
export class SmaService
  implements
    HasLatest<SmaReading>,
    HasRange,
    HasHistory<SmaReading>,
    Configurable<SmaConfig>
{
  private readonly config: SingletonConfigStore<SmaConfig>;

  constructor(private readonly db: DbService) {
    this.config = new SingletonConfigStore<SmaConfig>(
      db,
      'sma_config',
      [
        { column: 'enabled', key: 'enabled', fromDb: asBool },
        { column: 'name', key: 'name', fromDb: asStringOrNull },
        { column: 'host', key: 'host', fromDb: asStringOrNull },
        { column: 'poll_interval_s', key: 'pollIntervalS', fromDb: asNumber },
      ],
      DEFAULT_CONFIG,
    );
  }

  getConfig(): Promise<SmaConfig> {
    return this.config.get();
  }

  saveConfig(c: SmaConfig): Promise<SmaConfig> {
    return this.config.save(c);
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
    return toDataRange(rows[0]);
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

  /**
   * Daily PV yield per local day, as the delta of the monotonic lifetime
   * counter total_yield_kwh (max - min per day, per device, then summed).
   *
   * NOT max(daily_yield_wh): the inverter keeps reporting the *previous* day's
   * daily_yield through the night until its own reset at first production, so
   * max() picked up yesterday's total - a day showing the prior day's value in
   * the morning. total_yield_kwh never resets, so its per-day delta is robust
   * (and matches daily_yield_wh exactly on a clean day).
   */
  async dailyEnergy(from: Date, to: Date): Promise<SmaDailySummary[]> {
    const { rows } = await this.db.query(
      `SELECT day, ROUND(sum(dev_yield)::numeric, 2) AS yield_kwh
         FROM (
           SELECT (bucket AT TIME ZONE $3)::date::text AS day, device_sn,
                  max(total_yield_kwh) - min(total_yield_kwh) AS dev_yield
             FROM sma_1hour
            WHERE bucket >= $1 AND bucket < $2
            GROUP BY 1, 2
         ) d
        GROUP BY day
        HAVING sum(dev_yield) > 0
        ORDER BY day`,
      [from, to, TIMEZONE],
    );
    return rows.map((r) => ({
      day: String(r['day']),
      yieldKwh: Number(r['yield_kwh']),
    }));
  }

  /**
   * Per-minute average PV power (from the sma_1min continuous aggregate).
   * A straight avg(grid_power) per 1-minute bucket - unlike the yield-based
   * energy figures, 0 W at night is a real reading (the collector keeps
   * writing asleep snapshots), not "no data", so no delta/gap logic is
   * needed here; a missing bucket (collector down) is simply absent from
   * the result and left for the caller to render as a gap.
   */
  async minutePower(from: Date, to: Date): Promise<SmaMinutePower[]> {
    const { rows } = await this.db.query(
      `SELECT bucket, grid_power_avg
         FROM sma_1min
        WHERE bucket >= $1 AND bucket < $2
        ORDER BY bucket`,
      [from, to],
    );
    return rows.map((r) => ({
      time: new Date(r['bucket'] as string).toISOString(),
      powerW: Math.round(Number(r['grid_power_avg'] ?? 0)),
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

    return computeEnergyBalance(
      {
        production: pv[0]?.['production_kwh'],
        importKwh: grid[0]?.['import_kwh'],
        exportKwh: grid[0]?.['export_kwh'],
      },
      from,
      to,
    );
  }
}
