import { Injectable } from '@nestjs/common';
import type { SmaReading } from '@org/shared-types';
import type { HasLatestPerDevice } from '../common/device-capabilities';
import { DbService } from '../database/db.service';
import { rowToSmaReading } from './sma.mapper';

const READING_COLUMNS = `time, device_sn, asleep, grid_power, pv_power_a, pv_power_b,
  daily_yield_wh, total_yield_kwh, power_l1, power_l2, power_l3,
  pv_voltage_a, pv_voltage_b, pv_current_a, pv_current_b,
  voltage_l1, voltage_l2, voltage_l3, frequency, temp_a, status`;

/**
 * The inverters' own live readings — the part that is genuinely device-specific
 * (asleep flag, per-string DC values, inverter status code). Everything the
 * dashboard asks about PV *energy* is a producer-role question and lives in
 * EnergyService.
 */
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
}
