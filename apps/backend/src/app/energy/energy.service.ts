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
 * Per-device PV yield between adjacent hourly buckets over [$1, $2), plus one
 * leading hour so the first bucket in range still has a predecessor. Callers
 * keep only `gap = 1 hour` (no delta across a collector outage), `d >= 0` (no
 * counter reset) and `bucket >= $1`. Shared by {@link EnergyService.balance}
 * and {@link EnergyService.productionDaily} so the PV total and the PV bars
 * cannot drift apart.
 */
const PRODUCER_HOURLY_DELTAS = `
  SELECT bucket,
         total_yield_kwh - lag(total_yield_kwh) OVER w AS d,
         bucket - lag(bucket) OVER w AS gap
    FROM producer_1hour
   WHERE bucket >= ($1::timestamptz - INTERVAL '1 hour') AND bucket < $2
     AND total_yield_kwh IS NOT NULL
  WINDOW w AS (PARTITION BY device_sn ORDER BY bucket)`;

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
   * Reads the HOURLY aggregates, not the raw readings. The raw tables are
   * dropped after 30 (meter) and 90 (inverter) days, and not together: a
   * period reaching past 30 days kept its full PV figure while losing most of
   * its grid deltas, so Autarkie/Eigenverbrauch of any older week or month
   * came out near 100 % - and past 90 days the PV figure vanished as well.
   *
   * Both sides use the exact delta rule of `MeterService.energy()` (adjacent
   * hourly buckets per device, none across a gap, none negative), so the
   * balance's import/export are the Bezug/Einspeisung totals shown next to it
   * and its production is the sum of `productionDaily()`'s bars. Resolution is
   * whole hours: an hour counts when its bucket starts inside [from, to).
   *
   * Every counter delta is taken PER DEVICE and only then summed. A plain
   * delta across devices would subtract one device's counter from another's
   * and report a figure belonging to neither.
   */
  async balance(from: Date, to: Date): Promise<EnergyBalance> {
    // Two independent relations, so one round trip each, in parallel.
    const [{ rows: pv }, { rows: grid }] = await Promise.all([
      this.db.query(
        `SELECT sum(d) AS production_kwh
           FROM (${PRODUCER_HOURLY_DELTAS}) h
          WHERE gap = INTERVAL '1 hour' AND d >= 0 AND bucket >= $1`,
        [from, to],
      ),
      this.db.query(
        `SELECT sum(di) AS import_kwh, sum(de) AS export_kwh
           FROM (
             SELECT bucket,
                    grid_import_energy - lag(grid_import_energy) OVER w AS di,
                    grid_export_energy - lag(grid_export_energy) OVER w AS de,
                    bucket - lag(bucket) OVER w AS gap
               FROM grid_meter_1hour
              WHERE bucket >= ($1::timestamptz - INTERVAL '1 hour') AND bucket < $2
                AND grid_import_energy IS NOT NULL AND grid_export_energy IS NOT NULL
             WINDOW w AS (PARTITION BY device_sn ORDER BY bucket)
           ) h
          WHERE gap = INTERVAL '1 hour' AND di >= 0 AND de >= 0 AND bucket >= $1`,
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
   * total_yield_kwh between adjacent hourly buckets, per device, summed.
   *
   * NOT max(daily_yield_wh): the inverter keeps reporting the *previous* day's
   * daily_yield through the night until its own reset at first production, so
   * max() picked up yesterday's total - a day showing the prior day's value in
   * the morning. total_yield_kwh never resets, so its per-day delta is robust
   * (and matches daily_yield_wh exactly on a clean day).
   *
   * Same deltas as {@link balance}, so the bars add up to its production.
   */
  async productionDaily(from: Date, to: Date): Promise<ProductionDaySummary[]> {
    const { rows } = await this.db.query(
      `SELECT (bucket AT TIME ZONE $3)::date::text AS day,
              ROUND(sum(d)::numeric, 2) AS yield_kwh
         FROM (${PRODUCER_HOURLY_DELTAS}) h
        WHERE gap = INTERVAL '1 hour' AND d >= 0 AND bucket >= $1
        GROUP BY day
       HAVING sum(d) > 0
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
