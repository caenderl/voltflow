import { Injectable } from '@nestjs/common';
import type { BillingStatement } from '@org/shared-types';
import { TIMEZONE } from '../common/config';
import { numOrNull } from '../common/db-utils';
import { DbService } from '../database/db.service';
import {
  type BillingCheckpoint,
  type BillingTariff,
  type CounterKnot,
  computeBillingStatement,
  curveWindow,
} from './billing';

@Injectable()
export class BillingService {
  constructor(private readonly db: DbService) {}

  /**
   * Bill one calendar year against the hand-read meter.
   *
   * Everything the pure computation needs is resolved to absolute instants here,
   * in SQL, because month starts, reading times and tariff start dates are all
   * *local* wall-clock values — only Postgres has the timezone database to turn
   * them into instants across DST changes.
   */
  async statement(year: number): Promise<BillingStatement> {
    const monthStarts = await this.monthStarts(year);
    const from = new Date(monthStarts[0]);
    const to = new Date(monthStarts[monthStarts.length - 1]);
    const checkpoints = await this.checkpoints();

    // The curve has to reach past both ends of the year to whichever
    // checkpoints bound it there, otherwise an interval crossing a year
    // boundary has no smart meter delta on that side and falls back to a
    // pro-rata split for the whole interval, not just the part outside the year.
    const window = curveWindow(checkpoints, from.getTime(), to.getTime());

    return computeBillingStatement({
      year,
      monthStarts,
      checkpoints,
      knots: await this.knots(new Date(window.from), new Date(window.to)),
      tariffs: await this.tariffs(),
      daysInYear: isLeapYear(year) ? 366 : 365,
    });
  }

  /**
   * The 12 month starts plus the start of the next year, as instants. DST makes
   * these unequally spaced, which is exactly why they are generated in SQL.
   */
  private async monthStarts(year: number): Promise<number[]> {
    const { rows } = await this.db.query(
      `SELECT extract(epoch FROM generate_series(
                make_timestamp($1, 1, 1, 0, 0, 0),
                make_timestamp($1 + 1, 1, 1, 0, 0, 0),
                INTERVAL '1 month'
              ) AT TIME ZONE $2) * 1000 AS at`,
      [year, TIMEZONE],
    );
    return rows.map((r) => Number(r['at']));
  }

  /**
   * Every checkpoint, not just the year's: the intervals crossing either year
   * boundary need their outside endpoint to be billable at all. There are only
   * ever a handful of hand-entered rows, so the whole table is cheaper than
   * working out which two extra rows to fetch.
   */
  private async checkpoints(): Promise<BillingCheckpoint[]> {
    const { rows } = await this.db.query(
      `SELECT date::text, to_char(read_at, 'HH24:MI') AS read_at,
              import_kwh, export_kwh,
              extract(epoch FROM ((date + read_at) AT TIME ZONE $1)) * 1000 AS at
         FROM meter_checkpoint
        ORDER BY date, read_at`,
      [TIMEZONE],
    );
    return rows.map((r) => ({
      date: String(r['date']),
      readAt: String(r['read_at']),
      at: Number(r['at']),
      importKwh: Number(r['import_kwh']),
      exportKwh: Number(r['export_kwh']),
    }));
  }

  /**
   * The smart meter's cumulative counters as curve knots.
   *
   * Hourly buckets where they still exist (2 years of retention) and daily ones
   * for anything older (10 years) — the resolution only decides how precisely a
   * boundary inside a bucket can be placed, never the totals. Both aggregates
   * store `last(counter)` per bucket, so a knot is dated at the bucket's *end*;
   * a bucket whose end has not passed yet is left out rather than dated into the
   * future.
   *
   * Grouped by instant so a second `device_sn` cannot interleave two counters
   * into one non-monotonic curve.
   */
  private async knots(from: Date, to: Date): Promise<CounterKnot[]> {
    const { rows } = await this.db.query(
      `WITH h AS (
         SELECT bucket + INTERVAL '1 hour' AS at,
                grid_import_energy AS i, grid_export_energy AS e
           FROM meter_1hour
          WHERE bucket >= $1::timestamptz - INTERVAL '1 hour' AND bucket < $2
            AND grid_import_energy IS NOT NULL
            AND grid_export_energy IS NOT NULL
       ), d AS (
         SELECT bucket + INTERVAL '1 day' AS at,
                grid_import_energy AS i, grid_export_energy AS e
           FROM meter_1day
          WHERE bucket >= $1::timestamptz - INTERVAL '1 day' AND bucket < $2
            AND grid_import_energy IS NOT NULL
            AND grid_export_energy IS NOT NULL
            AND bucket + INTERVAL '1 day'
                < COALESCE((SELECT min(at) FROM h), 'infinity'::timestamptz)
       )
       SELECT extract(epoch FROM at) * 1000 AS at,
              max(i) AS import_kwh, max(e) AS export_kwh
         FROM (SELECT * FROM h UNION ALL SELECT * FROM d) k
        WHERE at <= now()
        GROUP BY at
        ORDER BY at`,
      [from, to],
    );
    return rows.map((r) => ({
      at: Number(r['at']),
      importKwh: Number(r['import_kwh']),
      exportKwh: Number(r['export_kwh']),
    }));
  }

  /** Tariffs with their start dates resolved to instants (local midnight). */
  private async tariffs(): Promise<BillingTariff[]> {
    const { rows } = await this.db.query(
      `SELECT extract(epoch FROM (valid_from::timestamp AT TIME ZONE $1)) * 1000 AS at,
              import_ct_kwh, export_ct_kwh, base_eur_per_year
         FROM tariff_period
        ORDER BY valid_from`,
      [TIMEZONE],
    );
    return rows.map((r) => ({
      at: Number(r['at']),
      importCtPerKwh: numOrNull(r['import_ct_kwh']),
      exportCtPerKwh: numOrNull(r['export_ct_kwh']),
      baseEurPerYear: numOrNull(r['base_eur_per_year']),
    }));
  }
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}
