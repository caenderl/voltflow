import { Injectable } from '@nestjs/common';
import type { Tariff } from '@org/shared-types';
import { DbService } from '../database/db.service';

const EMPTY: Tariff = { provider: null, importCtPerKwh: null, exportCtPerKwh: null };

@Injectable()
export class TariffService {
  constructor(private readonly db: DbService) {}

  async get(): Promise<Tariff> {
    const { rows } = await this.db.query(
      `SELECT provider, import_ct_kwh, export_ct_kwh FROM tariff WHERE id = 1`,
    );
    if (!rows.length) return { ...EMPTY };
    const r = rows[0];
    return {
      provider: (r['provider'] as string) ?? null,
      importCtPerKwh: numOrNull(r['import_ct_kwh']),
      exportCtPerKwh: numOrNull(r['export_ct_kwh']),
    };
  }

  async save(t: Tariff): Promise<Tariff> {
    await this.db.query(
      `INSERT INTO tariff (id, provider, import_ct_kwh, export_ct_kwh, updated_at)
       VALUES (1, $1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE
         SET provider = EXCLUDED.provider,
             import_ct_kwh = EXCLUDED.import_ct_kwh,
             export_ct_kwh = EXCLUDED.export_ct_kwh,
             updated_at = now()`,
      [t.provider ?? null, t.importCtPerKwh ?? null, t.exportCtPerKwh ?? null],
    );
    return this.get();
  }
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}
