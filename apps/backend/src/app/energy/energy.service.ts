import { Injectable } from '@nestjs/common';
import type {
  ConsumerMinuteEnergy,
  ConsumerDaySummary,
  EnergyBalance,
  ProductionDaySummary,
  ProductionMinutePower,
} from '@org/shared-types';
import { TIMEZONE } from '../common/config';
import { DbService } from '../database/db.service';
import { computeEnergyBalance } from './energy-balance';

/**
 * What the house produced, drew and fed back — every figure the dashboard shows
 * about energy rather than about a particular box.
 *
 * These are domain questions, not device ones, which is why they live here and
 * not in the SMA or wallbox modules where they grew up: "how much did we
 * produce" does not become a different question because the inverter is
 * replaced. Every query reads a ROLE view (`producer_*`, `grid_meter_*`,
 * `consumer_*`), so which vendor served the role never reaches this file.
 *
 * The device modules keep exactly what is genuinely device-specific: the live
 * readings, with their own status codes and per-phase values.
 *
 * A caveat worth knowing: a role view filters ONE vendor relation by role
 * (`producer_1hour` is `sma_1hour` minus non-producers). It is not yet a union
 * across drivers, so a second producer counts here only while it writes into
 * the same table. Making that a union is a schema change, not a change to this
 * file - which is the point of reading views rather than tables.
 */
@Injectable()
export class EnergyService {
  constructor(private readonly db: DbService) {}

  /**
   * Energy balance over [from, to): production (the producers' total_yield
   * delta) against grid import/export (the grid meter's counter deltas).
   *
   * Every counter delta is taken PER DEVICE and only then summed. A plain
   * max() - min() across devices would subtract one device's counter from
   * another's and report a figure belonging to neither.
   */
  async balance(from: Date, to: Date): Promise<EnergyBalance> {
    // Two independent relations, so one round trip each, in parallel.
    const [{ rows: pv }, { rows: grid }] = await Promise.all([
      this.db.query(
        `SELECT sum(dev_yield) AS production_kwh
           FROM (
             SELECT max(total_yield_kwh) - min(total_yield_kwh) AS dev_yield
               FROM producer_readings
              WHERE time >= $1 AND time < $2
              GROUP BY device_sn
           ) d`,
        [from, to],
      ),
      this.db.query(
        `SELECT sum(dev_import) AS import_kwh, sum(dev_export) AS export_kwh
           FROM (
             SELECT max(grid_import_energy) - min(grid_import_energy) AS dev_import,
                    max(grid_export_energy) - min(grid_export_energy) AS dev_export
               FROM grid_meter_readings
              WHERE time >= $1 AND time < $2
              GROUP BY device_sn
           ) d`,
        [from, to],
      ),
    ]);

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

  /**
   * PV yield per local day, as the delta of the monotonic lifetime counter
   * total_yield_kwh (max - min per day, per device, then summed).
   *
   * NOT max(daily_yield_wh): the inverter keeps reporting the *previous* day's
   * daily_yield through the night until its own reset at first production, so
   * max() picked up yesterday's total - a day showing the prior day's value in
   * the morning. total_yield_kwh never resets, so its per-day delta is robust
   * (and matches daily_yield_wh exactly on a clean day).
   */
  async productionDaily(from: Date, to: Date): Promise<ProductionDaySummary[]> {
    const { rows } = await this.db.query(
      `SELECT day, ROUND(sum(dev_yield)::numeric, 2) AS yield_kwh
         FROM (
           SELECT (bucket AT TIME ZONE $3)::date::text AS day, device_sn,
                  max(total_yield_kwh) - min(total_yield_kwh) AS dev_yield
             FROM producer_1hour
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
   * Per-minute average PV power. A straight avg per bucket - unlike the
   * yield-based figures, 0 W at night is a real reading (the collector keeps
   * writing asleep snapshots), not "no data", so no delta/gap logic is needed;
   * a missing bucket (collector down) is simply absent and left for the caller
   * to render as a gap.
   *
   * Summed across devices: the series is the site's PV power, so a second
   * inverter adds to the same minute instead of emitting a second point for it.
   */
  async productionMinute(from: Date, to: Date): Promise<ProductionMinutePower[]> {
    const { rows } = await this.db.query(
      `SELECT bucket, sum(grid_power_avg) AS grid_power_avg
         FROM producer_1min
        WHERE bucket >= $1 AND bucket < $2
        GROUP BY bucket
        ORDER BY bucket`,
      [from, to],
    );
    return rows.map((r) => ({
      time: new Date(r['bucket'] as string).toISOString(),
      powerW: Math.round(Number(r['grid_power_avg'] ?? 0)),
    }));
  }

  /**
   * Energy drawn by the separately metered consumers per local day, summed
   * across them. Only days with activity are returned.
   */
  async consumersDaily(from: Date, to: Date): Promise<ConsumerDaySummary[]> {
    const { rows } = await this.db.query(
      `SELECT (bucket AT TIME ZONE $3)::date::text AS day,
              ROUND(sum(charged_kwh)::numeric, 2)  AS energy_kwh
         FROM consumer_1day
        WHERE bucket >= $1 AND bucket < $2
        GROUP BY day
       HAVING COALESCE(sum(charged_kwh), 0) > 0
        ORDER BY day`,
      [from, to, TIMEZONE],
    );
    return rows.map((r) => ({
      day: String(r['day']),
      energyKwh: Number(r['energy_kwh']),
    }));
  }

  /**
   * The same per minute, for the day view.
   *
   * Reads the minute aggregate rather than shipping every raw reading for the
   * client to integrate: the aggregate holds exactly this figure already (the
   * collector's measured per-reading energy_wh, summed while charging), it is
   * role-filtered, and it is a fraction of the payload. Buckets with no
   * charging are absent, which the caller renders as zero - unlike PV, 0 is a
   * real value here, not a gap.
   */
  async consumersMinute(from: Date, to: Date): Promise<ConsumerMinuteEnergy[]> {
    const { rows } = await this.db.query(
      `SELECT bucket, sum(charged_kwh) AS energy_kwh
         FROM consumer_1min
        WHERE bucket >= $1 AND bucket < $2
        GROUP BY bucket
       HAVING COALESCE(sum(charged_kwh), 0) > 0
        ORDER BY bucket`,
      [from, to],
    );
    return rows.map((r) => ({
      time: new Date(r['bucket'] as string).toISOString(),
      energyKwh: Number(r['energy_kwh']),
    }));
  }
}
