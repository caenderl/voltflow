import { Injectable } from '@nestjs/common';
import type { StatPeak, StatisticsResponse } from '@org/shared-types';
import { TIMEZONE } from '../common/config';
import { DbService } from '../database/db.service';
import {
  type HourEnergy,
  type NightBaseline,
  computeStatistics,
} from './statistics';

/** Hours of a night the base load is read from: local 00:00 until this hour. */
const NIGHT_END_HOUR = 5;
/** Minutes a night must have to be usable (of 5 × 60). */
const MIN_NIGHT_SAMPLES = 240;
/**
 * Percentile of a night's house load taken as its base load. Not the minimum:
 * a single quiet minute is noise, not the level the house sits at.
 */
const NIGHT_PERCENTILE = 0.1;

@Injectable()
export class StatisticsService {
  constructor(private readonly db: DbService) {}

  /**
   * All-time records over everything the database still holds.
   *
   * The energy figures come from the *hourly* aggregates: house load is only
   * defined where meter and inverter can be compared over the same bucket, and
   * the two daily aggregates are bucketed in different zones (the meter's in
   * UTC, the inverter's in local time), so pairing them would compare
   * two-hour-shifted days. Hourly buckets are UTC on both sides and join
   * exactly; the local day is assembled from them here.
   */
  async statistics(): Promise<StatisticsResponse> {
    const [hours, nights, pvPeak, housePeak] = await Promise.all([
      this.hourlyEnergy(),
      this.nightBaselines(),
      this.pvPeak(),
      this.housePeak(),
    ]);

    return computeStatistics({
      hours,
      nights,
      pvPeak,
      housePeak: housePeak.peak,
      peakWindowDays: housePeak.windowDays,
    });
  }

  /**
   * Per-hour energy: PV production plus the meter's import / feed-in, each as
   * the delta of its cumulative counter between two adjacent buckets.
   *
   * Adjacent, not `max − min` within the day: the aggregates store `last()` per
   * bucket, so a day's `min` is its *first hour's end* — that reading of the
   * counters would silently drop the first hour of every day.
   *
   * A delta is only taken where the previous bucket is exactly one hour back,
   * which is what keeps a collector outage from booking the whole gap onto the
   * hour it ended in. Negative deltas are dropped as well (a meter swap or a
   * counter reset, never consumption).
   *
   * PV is null where the inverter has no bucket — unknown, not zero — except
   * when there is no inverter data at all: a house without PV consumes exactly
   * what it imports, and every figure here would otherwise be empty.
   */
  private async hourlyEnergy(): Promise<HourEnergy[]> {
    const { rows } = await this.db.query(
      `WITH pv AS (
         SELECT bucket, sum(d) AS pv_kwh FROM (
           SELECT bucket,
                  total_yield_kwh - lag(total_yield_kwh) OVER w AS d,
                  bucket - lag(bucket) OVER w AS gap
             FROM producer_1hour
            WHERE total_yield_kwh IS NOT NULL
           WINDOW w AS (PARTITION BY device_sn ORDER BY bucket)
         ) x
          WHERE gap = INTERVAL '1 hour' AND d >= 0
          GROUP BY bucket
       ), grid AS (
         SELECT bucket, sum(di) AS import_kwh, sum(de) AS export_kwh FROM (
           SELECT bucket,
                  grid_import_energy - lag(grid_import_energy) OVER w AS di,
                  grid_export_energy - lag(grid_export_energy) OVER w AS de,
                  bucket - lag(bucket) OVER w AS gap
             FROM grid_meter_1hour
            WHERE grid_import_energy IS NOT NULL AND grid_export_energy IS NOT NULL
           WINDOW w AS (PARTITION BY device_sn ORDER BY bucket)
         ) x
          WHERE gap = INTERVAL '1 hour' AND di >= 0 AND de >= 0
          GROUP BY bucket
       )
       SELECT (g.bucket AT TIME ZONE $1)::date::text        AS day,
              extract(hour FROM g.bucket AT TIME ZONE $1)   AS hour,
              p.pv_kwh, g.import_kwh, g.export_kwh,
              EXISTS (SELECT 1 FROM producer_1hour) AS has_pv
         FROM grid g
         LEFT JOIN pv p ON p.bucket = g.bucket
        ORDER BY g.bucket`,
      [TIMEZONE],
    );

    return rows.map((r) => ({
      day: String(r['day']),
      hour: Number(r['hour']),
      pvKwh: r['pv_kwh'] !== null ? Number(r['pv_kwh']) : r['has_pv'] ? null : 0,
      importKwh: Number(r['import_kwh']),
      exportKwh: Number(r['export_kwh']),
    }));
  }

  /**
   * One base load per night, as a low percentile of the house load between
   * midnight and 05:00 local.
   *
   * The consumers' own draw is taken back out: a car charging overnight is the
   * opposite of standby, and at ~2.5 kW it would bury the few hundred watts
   * this figure is about. Every device carrying the `consumer` role counts,
   * so a second wallbox needs no change here. Nights the collector only half
   * covered are dropped rather than averaged over a shorter window.
   */
  private async nightBaselines(): Promise<NightBaseline[]> {
    const { rows } = await this.db.query(
      `WITH consumers AS (
         SELECT bucket, sum(avg_power_w) AS power_w
           FROM consumer_1min
          WHERE extract(hour FROM bucket AT TIME ZONE $1) < $2
          GROUP BY bucket
       ), n AS (
         SELECT (h.bucket AT TIME ZONE $1)::date::text AS day,
                GREATEST(h.house_power - COALESCE(c.power_w, 0), 0) AS load_w
           FROM house_load_1min h
           LEFT JOIN consumers c ON c.bucket = h.bucket
          WHERE h.house_power IS NOT NULL
            AND extract(hour FROM h.bucket AT TIME ZONE $1) < $2
       )
       SELECT day,
              percentile_cont($3) WITHIN GROUP (ORDER BY load_w) AS watts
         FROM n
        GROUP BY day
       HAVING count(*) >= $4
        ORDER BY day`,
      [TIMEZONE, NIGHT_END_HOUR, NIGHT_PERCENTILE, MIN_NIGHT_SAMPLES],
    );
    return rows.map((r) => ({ day: String(r['day']), watts: Number(r['watts']) }));
  }

  /**
   * Highest production ever measured. Read from the daily aggregate, which is
   * the one kept long-term, and dated to the hour from the hourly aggregate
   * while that still reaches back to the day in question.
   */
  private async pvPeak(): Promise<StatPeak | null> {
    const { rows } = await this.db.query(
      `WITH d AS (
         SELECT bucket AS day, grid_power_max AS power_w
           FROM producer_1day
          WHERE grid_power_max IS NOT NULL
          ORDER BY grid_power_max DESC
          LIMIT 1
       )
       SELECT d.power_w,
              COALESCE((SELECT h.bucket
                          FROM producer_1hour h
                         WHERE h.bucket >= d.day
                           AND h.bucket < d.day + INTERVAL '1 day'
                           AND h.grid_power_max IS NOT NULL
                         ORDER BY h.grid_power_max DESC
                         LIMIT 1), d.day) AS at
         FROM d`,
    );
    if (!rows.length) return null;
    return {
      time: new Date(rows[0]['at'] as string).toISOString(),
      powerW: Math.round(Number(rows[0]['power_w'])),
    };
  }

  /**
   * Highest house load, on the 1-minute grid — the finest resolution the house
   * load exists at, and the only one at which a "peak" means anything (the
   * hourly aggregates hold averages, which flatten every peak away).
   *
   * That grid lives as long as the minute aggregate is retained, so the figure
   * is reported together with how far back it actually reaches.
   */
  private async housePeak(): Promise<{ peak: StatPeak | null; windowDays: number }> {
    const [peak, window] = await Promise.all([
      this.db.query(
        `SELECT bucket, house_power
           FROM house_load_1min
          WHERE house_power IS NOT NULL
          ORDER BY house_power DESC
          LIMIT 1`,
      ),
      this.db.query(
        `SELECT extract(day FROM now() - min(bucket)) AS days FROM grid_meter_1min`,
      ),
    ]);
    return {
      peak: peak.rows.length
        ? {
            time: new Date(peak.rows[0]['bucket'] as string).toISOString(),
            powerW: Math.round(Number(peak.rows[0]['house_power'])),
          }
        : null,
      windowDays: Math.max(Math.round(Number(window.rows[0]?.['days'] ?? 0)), 0),
    };
  }
}
