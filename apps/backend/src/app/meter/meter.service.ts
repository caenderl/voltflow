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
 * here. latest()/range() below stay on the raw table on purpose: those describe
 * one device, and latest() even names it.
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

  async range(): Promise<DataRange> {
    const { rows } = await this.db.query(
      `SELECT min(time) AS first, max(time) AS last FROM meter_reading`,
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
   * Energy summary for a time range. kWh = delta of the cumulative meter
   * readings (max - min per bucket; the counter is monotonically increasing),
   * taken per device and only then summed - a plain max() - min() across
   * devices would subtract one meter's counter from another's. The same shape
   * billing and the checkpoint reconciliation already use.
   */
  async energy(
    period: EnergyPeriod,
    from: Date,
    to: Date,
  ): Promise<EnergySummary> {
    const bucketInterval = period === 'day' ? '1 hour' : '1 day';

    // Bucket in local time so a "day" is a local calendar day (not a UTC day).
    const { rows } = await this.db.query(
      `SELECT bucket, sum(dev_import) AS import_kwh, sum(dev_export) AS export_kwh
         FROM (
           SELECT time_bucket($1::interval, time, $4) AS bucket, device_sn,
                  max(grid_import_energy) - min(grid_import_energy) AS dev_import,
                  max(grid_export_energy) - min(grid_export_energy) AS dev_export
             FROM grid_meter_readings
            WHERE time >= $2 AND time < $3
            GROUP BY bucket, device_sn
         ) d
        GROUP BY bucket
        ORDER BY bucket`,
      [bucketInterval, from, to, TIMEZONE],
    );

    const buckets: EnergyBucket[] = rows.map((r) => ({
      time: new Date(r['bucket'] as string).toISOString(),
      importKwh: round3(Number(r['import_kwh'] ?? 0)),
      exportKwh: round3(Number(r['export_kwh'] ?? 0)),
    }));

    // Totals computed directly as a delta over the whole range (more accurate
    // than summing the buckets).
    const { rows: totalRows } = await this.db.query(
      `SELECT sum(dev_import) AS import_kwh, sum(dev_export) AS export_kwh
         FROM (
           SELECT max(grid_import_energy) - min(grid_import_energy) AS dev_import,
                  max(grid_export_energy) - min(grid_export_energy) AS dev_export
             FROM grid_meter_readings
            WHERE time >= $1 AND time < $2
            GROUP BY device_sn
         ) d`,
      [from, to],
    );
    const total = totalRows[0] ?? {};

    return {
      period,
      from: from.toISOString(),
      to: to.toISOString(),
      importKwh: round3(Number(total['import_kwh'] ?? 0)),
      exportKwh: round3(Number(total['export_kwh'] ?? 0)),
      buckets,
    };
  }
}
