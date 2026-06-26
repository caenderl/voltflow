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
import { DbService, rowToReading } from '../database/db.service';

/** Timezone for day-boundary bucketing (overridable via TZ env). */
const TIMEZONE = process.env.TZ || 'Europe/Berlin';

/** Aggregate view per resolution. */
const VIEW_BY_RESOLUTION: Record<Exclude<SeriesResolution, 'raw'>, string> = {
  '1min': 'meter_1min',
  '1hour': 'meter_1hour',
  '1day': 'meter_1day',
};

@Injectable()
export class MeterService {
  constructor(private readonly db: DbService) {}

  async range(): Promise<DataRange> {
    const { rows } = await this.db.query(
      `SELECT min(time) AS first, max(time) AS last FROM meter_reading`,
    );
    const r = rows[0] ?? {};
    return {
      first: r['first'] ? new Date(r['first'] as string).toISOString() : null,
      last: r['last'] ? new Date(r['last'] as string).toISOString() : null,
    };
  }

  async latest(): Promise<MeterReading | null> {
    const { rows } = await this.db.query(
      `SELECT time, device_sn, grid_to_home_power, pv_to_grid_power,
              grid_import_energy, grid_export_energy
         FROM meter_reading
        ORDER BY time DESC
        LIMIT 1`,
    );
    return rows.length ? rowToReading(rows[0]) : null;
  }

  async series(
    from: Date,
    to: Date,
    resolution: SeriesResolution,
  ): Promise<SeriesResponse> {
    let points: SeriesPoint[];

    if (resolution === 'raw') {
      const { rows } = await this.db.query(
        `SELECT time, grid_to_home_power, pv_to_grid_power
           FROM meter_reading
          WHERE time >= $1 AND time < $2
          ORDER BY time`,
        [from, to],
      );
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
                grid_to_home_power_avg, grid_to_home_power_max,
                pv_to_grid_power_avg, pv_to_grid_power_max
           FROM ${view}
          WHERE bucket >= $1 AND bucket < $2
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
   * readings (max - min per bucket; the counter is monotonically increasing).
   */
  async energy(
    period: EnergyPeriod,
    from: Date,
    to: Date,
  ): Promise<EnergySummary> {
    const bucketInterval = period === 'day' ? '1 hour' : '1 day';

    // Bucket in local time so a "day" is a local calendar day (not a UTC day).
    const { rows } = await this.db.query(
      `SELECT time_bucket($1::interval, time, $4) AS bucket,
              max(grid_import_energy) - min(grid_import_energy) AS import_kwh,
              max(grid_export_energy) - min(grid_export_energy) AS export_kwh
         FROM meter_reading
        WHERE time >= $2 AND time < $3
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
      `SELECT max(grid_import_energy) - min(grid_import_energy) AS import_kwh,
              max(grid_export_energy) - min(grid_export_energy) AS export_kwh
         FROM meter_reading
        WHERE time >= $1 AND time < $2`,
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

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
