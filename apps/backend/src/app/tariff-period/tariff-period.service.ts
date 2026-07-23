import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { TariffPeriod, TariffPeriodInput } from '@org/shared-types';
import { numOrNull } from '../common/db-utils';
import { DbService } from '../database/db.service';

/** Postgres unique_violation, raised by the one-tariff-per-date constraint. */
const UNIQUE_VIOLATION = '23505';

@Injectable()
export class TariffPeriodService {
  constructor(private readonly db: DbService) {}

  async list(): Promise<TariffPeriod[]> {
    const { rows } = await this.db.query(
      `SELECT id, valid_from::text, provider, import_ct_kwh, export_ct_kwh
         FROM tariff_period
        ORDER BY valid_from DESC`,
    );
    return rows.map(rowToPeriod);
  }

  async create(input: TariffPeriodInput): Promise<TariffPeriod> {
    try {
      const { rows } = await this.db.query(
        `INSERT INTO tariff_period (valid_from, provider, import_ct_kwh, export_ct_kwh)
         VALUES ($1, $2, $3, $4)
         RETURNING id, valid_from::text, provider, import_ct_kwh, export_ct_kwh`,
        [input.validFrom, input.provider, input.importCtPerKwh, input.exportCtPerKwh],
      );
      return rowToPeriod(rows[0]);
    } catch (err) {
      throw asDateConflict(err, input.validFrom);
    }
  }

  async update(id: number, input: TariffPeriodInput): Promise<TariffPeriod> {
    let rows;
    try {
      ({ rows } = await this.db.query(
        `UPDATE tariff_period
            SET valid_from = $2, provider = $3, import_ct_kwh = $4, export_ct_kwh = $5
          WHERE id = $1
          RETURNING id, valid_from::text, provider, import_ct_kwh, export_ct_kwh`,
        [id, input.validFrom, input.provider, input.importCtPerKwh, input.exportCtPerKwh],
      ));
    } catch (err) {
      throw asDateConflict(err, input.validFrom);
    }
    if (!rows.length) throw new NotFoundException(`Tariff period ${id} not found`);
    return rowToPeriod(rows[0]);
  }

  async remove(id: number): Promise<void> {
    const { rows } = await this.db.query(
      `DELETE FROM tariff_period WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!rows.length) throw new NotFoundException(`Tariff period ${id} not found`);
  }
}

/**
 * Turn the unique-violation on valid_from into a 409, so a second tariff for the
 * same start date reads as "already recorded" instead of a generic 500.
 */
function asDateConflict(err: unknown, validFrom: string): unknown {
  return (err as { code?: string } | null)?.code === UNIQUE_VIOLATION
    ? new ConflictException(`A tariff period starting ${validFrom} already exists`)
    : err;
}

function rowToPeriod(r: Record<string, unknown>): TariffPeriod {
  return {
    id: Number(r['id']),
    validFrom: String(r['valid_from']),
    provider: (r['provider'] as string | null) ?? null,
    importCtPerKwh: numOrNull(r['import_ct_kwh']),
    exportCtPerKwh: numOrNull(r['export_ct_kwh']),
  };
}
