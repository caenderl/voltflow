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
   * Energy balance over [from, to): production against grid import/export,
   * both summed from the hourly ledger (`producer_energy_1hour`,
   * `grid_energy_1hour`, schema.ts 084/085). Those are the very hours behind
   * the Bezug/Einspeisung and PV bars, so the balance's import/export are the
   * bar totals and its production is the sum of the PV bars - by
   * construction, not by keeping three queries in step.
   *
   * Resolution is whole hours: an hour counts when its bucket starts inside
   * [from, to). The ledger sits on the hourly aggregates (kept two years), not
   * the raw readings, which were dropped after 30 / 90 days and once left older
   * months with full PV but hardly any grid figures (Autarkie near 100 %).
   */
  async balance(from: Date, to: Date): Promise<EnergyBalance> {
    // Two independent relations, so one round trip each, in parallel.
    const [{ rows: pv }, { rows: grid }] = await Promise.all([
      this.db.query(
        `SELECT sum(pv_kwh) AS production_kwh
           FROM producer_energy_1hour
          WHERE bucket >= $1 AND bucket < $2`,
        [from, to],
      ),
      this.db.query(
        `SELECT sum(import_kwh) AS import_kwh, sum(export_kwh) AS export_kwh
           FROM grid_energy_1hour
          WHERE bucket >= $1 AND bucket < $2`,
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
   * PV yield per local day: the producer ledger (`producer_energy_1hour`)
   * summed per local day, across devices.
   *
   * The ledger reads the monotonic lifetime counter total_yield_kwh, NOT
   * daily_yield_wh: the inverter keeps reporting the *previous* day's
   * daily_yield through the night until its own reset at first production, so
   * max(daily_yield) picked up yesterday's total in the morning. total_yield
   * never resets (and matches daily_yield exactly on a clean day).
   *
   * Same hours as {@link balance}, so the bars add up to its production.
   */
  async productionDaily(from: Date, to: Date): Promise<ProductionDaySummary[]> {
    const { rows } = await this.db.query(
      `SELECT (bucket AT TIME ZONE $3)::date::text AS day,
              ROUND(sum(pv_kwh)::numeric, 2) AS yield_kwh
         FROM producer_energy_1hour
        WHERE bucket >= $1 AND bucket < $2
        GROUP BY day
       HAVING sum(pv_kwh) > 0
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
