import { Injectable } from '@nestjs/common';
import type {
  SmaDailySummary,
  SmaMinutePower,
  SmaReading,
} from '@org/shared-types';
import { TIMEZONE } from '../common/config';
import type { HasLatestPerDevice } from '../common/device-capabilities';
import { DbService } from '../database/db.service';
import { rowToSmaReading } from './sma.mapper';

const READING_COLUMNS = `time, device_sn, asleep, grid_power, pv_power_a, pv_power_b,
  daily_yield_wh, total_yield_kwh, power_l1, power_l2, power_l3,
  pv_voltage_a, pv_voltage_b, pv_current_a, pv_current_b,
  voltage_l1, voltage_l2, voltage_l3, frequency, temp_a, status`;

@Injectable()
export class SmaService implements HasLatestPerDevice<SmaReading> {
  constructor(private readonly db: DbService) {}

  /**
   * Last reading of every inverter. `DISTINCT ON` over the `(device_sn, time)`
   * index, which TimescaleDB serves with a SkipScan per chunk (measured: 0.6 ms
   * over 168k rows) instead of reading the rows it skips.
   */
  async latestPerDevice(): Promise<SmaReading[]> {
    const { rows } = await this.db.query(
      `SELECT DISTINCT ON (device_sn) ${READING_COLUMNS}
         FROM sma_readings
        ORDER BY device_sn, time DESC`,
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
   * Per-minute average PV power (from the sma_1min continuous aggregate).
   * A straight avg(grid_power) per 1-minute bucket - unlike the yield-based
   * energy figures, 0 W at night is a real reading (the collector keeps
   * writing asleep snapshots), not "no data", so no delta/gap logic is
   * needed here; a missing bucket (collector down) is simply absent from
   * the result and left for the caller to render as a gap.
   *
   * Summed across devices (the cagg is grouped by device_sn): the series is
   * the site's PV power, so a second inverter adds to the same minute instead
   * of emitting a second point for it.
   */
  async minutePower(from: Date, to: Date): Promise<SmaMinutePower[]> {
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
}
