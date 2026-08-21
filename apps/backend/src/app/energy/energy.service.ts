import { Injectable } from '@nestjs/common';
import type { EnergyBalance } from '@org/shared-types';
import { DbService } from '../database/db.service';
import { computeEnergyBalance } from './energy-balance';

/**
 * The household energy balance: what was produced, drawn and fed back over a
 * range, and what that makes of self-consumption and autarky.
 *
 * This is a domain question, not a device one, which is why it lives here and
 * not in the SMA module where it grew up: "how autark was the house" does not
 * become a different question because the inverter is replaced. It reads the
 * role views (`producer_readings`, `grid_meter_readings`) rather than
 * `sma_readings`/`meter_reading`, so a second producer counts without a line
 * changing here.
 */
@Injectable()
export class EnergyService {
  constructor(private readonly db: DbService) {}

  /**
   * Energy balance over [from, to): production (the producers' total_yield
   * delta) against grid import/export (the grid meter's counter deltas).
   *
   * Every counter delta is taken PER DEVICE and only then summed. A plain
   * max() - min() across devices would subtract one device's counter from
   * another's and report a figure belonging to neither.
   */
  async balance(from: Date, to: Date): Promise<EnergyBalance> {
    // Two independent relations, so one round trip each, in parallel.
    const [{ rows: pv }, { rows: grid }] = await Promise.all([
      this.db.query(
        `SELECT sum(dev_yield) AS production_kwh
           FROM (
             SELECT max(total_yield_kwh) - min(total_yield_kwh) AS dev_yield
               FROM producer_readings
              WHERE time >= $1 AND time < $2
              GROUP BY device_sn
           ) d`,
        [from, to],
      ),
      this.db.query(
        `SELECT sum(dev_import) AS import_kwh, sum(dev_export) AS export_kwh
           FROM (
             SELECT max(grid_import_energy) - min(grid_import_energy) AS dev_import,
                    max(grid_export_energy) - min(grid_export_energy) AS dev_export
               FROM grid_meter_readings
              WHERE time >= $1 AND time < $2
              GROUP BY device_sn
           ) d`,
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
}
