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

/**
 * How long a computed result is served again. The figures are all-time
 * records over hourly aggregates (and a 1-minute peak), so ten minutes of
 * delay changes nothing anyone reads off them; recomputing costs ~0.4 s in
 * prod and grows with the history the hourly aggregates keep (two years).
 * The one visible staleness: a device's roles changed in the admin page reach
 * the statistics up to ten minutes later.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class StatisticsService {
  /**
   * The last computation, as a promise: concurrent requests while it is still
   * running share it instead of each starting their own.
   */
  private cached: { at: number; result: Promise<StatisticsResponse> } | null = null;

  constructor(private readonly db: DbService) {}

  /** {@link compute}, served from memory for {@link CACHE_TTL_MS}. */
  statistics(): Promise<StatisticsResponse> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CACHE_TTL_MS) return this.cached.result;

    const result = this.compute();
    this.cached = { at: now, result };
    // A failed computation must not be served for the next ten minutes.
    result.catch(() => {
      if (this.cached?.result === result) this.cached = null;
    });
    return result;
  }

  /**
   * All-time records over everything the database still holds.
   *
   * The energy figures come from the *hourly* aggregates: house load is only
   * defined where meter and inverter can be compared over the same bucket, and
   * the dark-hour, gap and battery logic needs hours, not days. Hourly buckets
   * are UTC on both sides and join exactly; the local day is assembled from
   * them here.
   */
  private async compute(): Promise<StatisticsResponse> {
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
   * Per-hour energy: PV production plus the meter's import / feed-in, from the
   * hourly ledger (`producer_energy_1hour`, `grid_energy_1hour`) - the same
   * hours the history bars and the balance sum.
   *
   * Only MEASURED hours: the ledger spreads an outage evenly over the hours it
   * covers (right for totals, meaningless for a record or a battery
   * simulation), so an hour any grid meter only has an estimate or no valid
   * delta for (a counter reset) is left out entirely, exactly as a missing
   * hour always was - which is what keeps a half-covered day out of the
   * records.
   *
   * PV is null where the inverter has no measured hour - unknown, not zero -
   * except when there is no inverter data at all: a house without PV consumes
   * exactly what it imports, and every figure here would otherwise be empty.
   *
   * The consumers' energy (every `consumer` device, i.e. the car) rides along
   * so the battery simulation can leave it out; an hour none of them charged
   * in has no `charged_kwh` and counts as 0. A consumer reports every hour it
   * is up, so an hour it skipped is an outage: whatever it drew then is
   * unknown, and NULL says so. That covers the hours between two reports, and
   * the hours since the last one while the device is still enabled - an
   * outage that is still going on. Before its first report, and after the last
   * one of a device no longer enabled, it is simply not there. `day_hours` is
   * the length of the local day, so the clock-change days are judged against
   * 23 / 25 h.
   *
   * The gaps are found from each report to the next (`lead`), so the series
   * only spans actual outages; `consumer_reports` is referenced twice and
   * therefore materialized, i.e. the view is read once.
   */
  private async hourlyEnergy(): Promise<HourEnergy[]> {
    const { rows } = await this.db.query(
      `WITH pv AS (
         SELECT bucket,
                CASE WHEN bool_or(estimated) OR count(pv_kwh) < count(*) THEN NULL
                     ELSE sum(pv_kwh) END AS pv_kwh
           FROM producer_energy_1hour
          GROUP BY bucket
       ), grid AS (
         SELECT bucket, sum(import_kwh) AS import_kwh, sum(export_kwh) AS export_kwh
           FROM grid_energy_1hour
          GROUP BY bucket
         HAVING NOT bool_or(estimated)
            AND count(import_kwh) = count(*) AND count(export_kwh) = count(*)
       ), consumer_reports AS (
         SELECT device_sn, bucket, charged_kwh FROM consumer_1hour
       ), consumers AS (
         SELECT bucket, sum(charged_kwh) AS consumer_kwh
           FROM consumer_reports
          GROUP BY bucket
       ), consumer_gaps AS (
         SELECT DISTINCT h.bucket
           FROM (SELECT r.bucket,
                        COALESCE(
                          lead(r.bucket) OVER (PARTITION BY r.device_sn ORDER BY r.bucket),
                          CASE WHEN EXISTS (SELECT 1 FROM device_config dc
                                             WHERE dc.device_sn = r.device_sn AND dc.enabled)
                               THEN date_trunc('hour', now()) + INTERVAL '1 hour' END
                        ) AS next
                   FROM consumer_reports r) r
          CROSS JOIN LATERAL generate_series(
            r.bucket + INTERVAL '1 hour', r.next - INTERVAL '1 hour', INTERVAL '1 hour') AS h(bucket)
          WHERE r.next > r.bucket + INTERVAL '1 hour'
       )
       SELECT l.day::text                                   AS day,
              extract(hour FROM g.bucket AT TIME ZONE $1)   AS hour,
              extract(epoch FROM ((l.day + 1)::timestamp AT TIME ZONE $1)
                               - (l.day::timestamp AT TIME ZONE $1)) / 3600
                                                            AS day_hours,
              p.pv_kwh, g.import_kwh, g.export_kwh,
              CASE WHEN cg.bucket IS NULL THEN COALESCE(c.consumer_kwh, 0) END
                                                            AS consumer_kwh,
              EXISTS (SELECT 1 FROM producer_1hour) AS has_pv
         FROM grid g
        CROSS JOIN LATERAL (SELECT (g.bucket AT TIME ZONE $1)::date AS day) l
         LEFT JOIN pv p ON p.bucket = g.bucket
         LEFT JOIN consumers c ON c.bucket = g.bucket
         LEFT JOIN consumer_gaps cg ON cg.bucket = g.bucket
        ORDER BY g.bucket`,
      [TIMEZONE],
    );

    return rows.map((r) => ({
      day: String(r['day']),
      hour: Number(r['hour']),
      pvKwh: r['pv_kwh'] !== null ? Number(r['pv_kwh']) : r['has_pv'] ? null : 0,
      importKwh: Number(r['import_kwh']),
      exportKwh: Number(r['export_kwh']),
      consumerKwh: r['consumer_kwh'] !== null ? Number(r['consumer_kwh']) : null,
      dayHours: Number(r['day_hours']),
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
