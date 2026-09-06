import { Injectable } from '@nestjs/common';
import type {
  DataRange,
  EnergyBucket,
  EnergyPeriod,
  EnergySummary,
  MeterReading,
  SeriesPoint,
  SeriesResolution,
  SeriesResponse,
} from '@org/shared-types';
import { TIMEZONE } from '../common/config';
import {
  MAX_RAW_ROWS,
  assertNotTruncated,
  numOrNull,
  round3,
  toDataRange,
} from '../common/db-utils';
import type { HasLatestPerDevice, HasRange } from '../common/device-capabilities';
import { DbService } from '../database/db.service';
import { rowToReading } from './meter.mapper';

/**
 * Aggregate view per resolution — the role views, not the raw caggs.
 *
 * "What did the house draw from the grid" is the `grid-meter` role's question,
 * not this vendor's, so a device that does not carry the role must not appear
 * here. latest() below stays on the raw table on purpose: it describes one
 * device and even names it.
 */
const VIEW_BY_RESOLUTION: Record<Exclude<SeriesResolution, 'raw'>, string> = {
  '1min': 'grid_meter_1min',
  '1hour': 'grid_meter_1hour',
  '1day': 'grid_meter_1day',
};

/** Postgres date_trunc field + matching interval for one energy period. */
const PERIOD_TRUNC: Record<EnergyPeriod, { field: string; interval: string }> = {
  day: { field: 'day', interval: '1 day' },
  week: { field: 'week', interval: '1 week' }, // date_trunc('week', …) starts Monday
  month: { field: 'month', interval: '1 month' },
};

@Injectable()
export class MeterService implements HasLatestPerDevice<MeterReading>, HasRange {
  constructor(private readonly db: DbService) {}

  /**
   * Resolves a period + reference instant to [from, to) in local wall-clock
   * time. Done in SQL, not with `Date.setHours` (process-local time): the
   * backend runs in UTC in prod, so a JS-local "day" would not be the actual
   * Europe/Berlin day. Same reasoning as {@link BillingService.monthStarts}.
   */
  async computeRange(
    period: EnergyPeriod,
    ref: Date,
  ): Promise<{ from: Date; to: Date }> {
    const { field, interval } = PERIOD_TRUNC[period];
    const { rows } = await this.db.query(
      `SELECT extract(epoch FROM date_trunc($1, $2::timestamptz AT TIME ZONE $4)
                       AT TIME ZONE $4) * 1000 AS from_ms,
              extract(epoch FROM (date_trunc($1, $2::timestamptz AT TIME ZONE $4)
                       + $3::interval) AT TIME ZONE $4) * 1000 AS to_ms`,
      [field, ref, interval, TIMEZONE],
    );
    return {
      from: new Date(Number(rows[0]['from_ms'])),
      to: new Date(Number(rows[0]['to_ms'])),
    };
  }

  /**
   * How far the history and billing views can page back/forward — so it must
   * report the span the CHARTS can render, not the raw table's. Raw
   * `meter_reading` is dropped after 30 days, while `energy()` reads
   * `grid_meter_1hour` (kept two years) for every period, so the hourly
   * aggregate is the real floor. Reading `min(time) FROM meter_reading` here
   * pinned "first" at 30 days ago and stranded every older month that still has
   * hourly data.
   */
  async range(): Promise<DataRange> {
    const { rows } = await this.db.query(
      `SELECT min(bucket) AS first, max(bucket) AS last FROM grid_meter_1hour`,
    );
    return toDataRange(rows[0]);
  }

  /** Last reading of every grid meter — see {@link SmaService.latestPerDevice}. */
  async latestPerDevice(): Promise<MeterReading[]> {
    const { rows } = await this.db.query(
      `SELECT DISTINCT ON (device_sn)
              time, device_sn, grid_to_home_power, pv_to_grid_power,
              grid_import_energy, grid_export_energy
         FROM meter_reading
        ORDER BY device_sn, time DESC`,
    );
    return rows.map(rowToReading);
  }

  async series(
    from: Date,
    to: Date,
    resolution: SeriesResolution,
  ): Promise<SeriesResponse> {
    let points: SeriesPoint[];

    if (resolution === 'raw') {
      // Deliberately not grouped, unlike the aggregated branches below: raw
      // rows carry the microsecond `now()` of their own insert, so two devices
      // never share a timestamp and there is nothing for a GROUP BY to combine.
      // Raw is a single device's trace by nature - the 1-minute resolution is
      // what puts several of them on a common grid.
      const { rows } = await this.db.query(
        `SELECT time, grid_to_home_power, pv_to_grid_power
           FROM meter_reading
          WHERE time >= $1 AND time < $2
          ORDER BY time
          LIMIT ${MAX_RAW_ROWS + 1}`,
        [from, to],
      );
      assertNotTruncated(rows.length, 'meter series');
      points = rows.map((r) => ({
        time: new Date(r['time'] as string).toISOString(),
        gridToHomePowerAvg: numOrNull(r['grid_to_home_power']),
        gridToHomePowerMax: numOrNull(r['grid_to_home_power']),
        pvToGridPowerAvg: numOrNull(r['pv_to_grid_power']),
        pvToGridPowerMax: numOrNull(r['pv_to_grid_power']),
      }));
    } else {
      const view = VIEW_BY_RESOLUTION[resolution];
      const { rows } = await this.db.query(
        `SELECT bucket,
                sum(grid_to_home_power_avg) AS grid_to_home_power_avg,
                max(grid_to_home_power_max) AS grid_to_home_power_max,
                sum(pv_to_grid_power_avg)   AS pv_to_grid_power_avg,
                max(pv_to_grid_power_max)   AS pv_to_grid_power_max
           FROM ${view}
          WHERE bucket >= $1 AND bucket < $2
          GROUP BY bucket
          ORDER BY bucket`,
        [from, to],
      );
      points = rows.map((r) => ({
        time: new Date(r['bucket'] as string).toISOString(),
        gridToHomePowerAvg: numOrNull(r['grid_to_home_power_avg']),
        gridToHomePowerMax: numOrNull(r['grid_to_home_power_max']),
        pvToGridPowerAvg: numOrNull(r['pv_to_grid_power_avg']),
        pvToGridPowerMax: numOrNull(r['pv_to_grid_power_max']),
      }));
    }

    return {
      resolution,
      from: from.toISOString(),
      to: to.toISOString(),
      points,
    };
  }

  /**
   * Energy summary for a time range. kWh = the cumulative meter counter's delta
   * between adjacent hourly buckets (`last()` per bucket, so the delta is
   * bucket-to-bucket, never max - min *within* a bucket, which would drop the
   * first hour), taken per device and only then summed - a plain delta across
   * devices would subtract one meter's counter from another's.
   *
   * Reads `grid_meter_1hour`, not the raw `grid_meter_readings`: the raw table
   * is dropped after 30 days, so a raw-backed query silently loses its earliest
   * bars the moment the period reaches past that window (a month view a few days
   * into a new month, any older week). The hourly aggregate is kept for two
   * years and is fine enough to re-bucket into local calendar days here.
   *
   * A delta is only taken where the previous bucket is exactly one hour back,
   * so a collector outage does not book the whole gap onto the hour it ended in;
   * negative deltas (a meter swap / counter reset) are dropped too. One extra
   * leading hour is pulled in so the first in-range bucket still has a
   * predecessor to diff against.
   */
  async energy(
    period: EnergyPeriod,
    from: Date,
    to: Date,
  ): Promise<EnergySummary> {
    // day -> one bar per hour (the aggregate's own bucket); week/month -> one
    // bar per LOCAL calendar day, so a "day" is not a UTC day. $3 is only
    // referenced on the non-day path, so it is passed only then (pg rejects a
    // param the statement never uses).
    const bucketExpr =
      period === 'day'
        ? 'bucket'
        : '((bucket AT TIME ZONE $3)::date::timestamp AT TIME ZONE $3)';
    const params =
      period === 'day' ? [from, to] : [from, to, TIMEZONE];

    const { rows } = await this.db.query(
      `WITH hourly AS (
         SELECT bucket,
                grid_import_energy - lag(grid_import_energy) OVER w AS di,
                grid_export_energy - lag(grid_export_energy) OVER w AS de,
                bucket - lag(bucket) OVER w AS gap
           FROM grid_meter_1hour
          WHERE bucket >= ($1::timestamptz - INTERVAL '1 hour') AND bucket < $2
            AND grid_import_energy IS NOT NULL AND grid_export_energy IS NOT NULL
          WINDOW w AS (PARTITION BY device_sn ORDER BY bucket)
       )
       SELECT ${bucketExpr} AS bucket,
              sum(di) AS import_kwh, sum(de) AS export_kwh
         FROM hourly
        WHERE gap = INTERVAL '1 hour' AND di >= 0 AND de >= 0 AND bucket >= $1
        GROUP BY 1
        ORDER BY 1`,
      params,
    );

    const buckets: EnergyBucket[] = rows.map((r) => ({
      time: new Date(r['bucket'] as string).toISOString(),
      importKwh: round3(Number(r['import_kwh'] ?? 0)),
      exportKwh: round3(Number(r['export_kwh'] ?? 0)),
    }));

    // Totals are the sum of the same adjacent-hour deltas, so the bucket sums
    // add up to them exactly - no separate range query needed.
    let importKwh = 0;
    let exportKwh = 0;
    for (const r of rows) {
      importKwh += Number(r['import_kwh'] ?? 0);
      exportKwh += Number(r['export_kwh'] ?? 0);
    }

    return {
      period,
      from: from.toISOString(),
      to: to.toISOString(),
      importKwh: round3(importKwh),
      exportKwh: round3(exportKwh),
      buckets,
    };
  }
}
