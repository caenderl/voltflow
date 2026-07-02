import { DbService } from '../database/db.service';

/** One column of a singleton config table, with its DB->TS conversion. */
export interface ConfigColumn<T> {
  /** snake_case DB column */
  column: string;
  /** camelCase key on the config type */
  key: keyof T;
  /** DB value -> config value (e.g. Boolean, Number, string-or-null) */
  fromDb: (v: unknown) => unknown;
}

export const asBool = (v: unknown): boolean => Boolean(v);
export const asNumber = (v: unknown): number => Number(v);
export const asStringOrNull = (v: unknown): string | null =>
  (v as string | null) ?? null;

/**
 * Persistence for a single-row (id = 1) config table: read with defaults for
 * the not-yet-saved case, save as idempotent upsert. Used by the tariff,
 * wallbox and SMA configs - one column list each instead of three copies of
 * the same SQL.
 */
export class SingletonConfigStore<T extends object> {
  constructor(
    private readonly db: DbService,
    private readonly table: string,
    private readonly columns: ConfigColumn<T>[],
    private readonly defaults: T,
  ) {}

  async get(): Promise<T> {
    const cols = this.columns.map((c) => c.column).join(', ');
    const { rows } = await this.db.query(
      `SELECT ${cols} FROM ${this.table} WHERE id = 1`,
    );
    if (!rows.length) return { ...this.defaults };
    const row = rows[0];
    const out = { ...this.defaults };
    for (const c of this.columns) {
      out[c.key] = c.fromDb(row[c.column]) as T[keyof T];
    }
    return out;
  }

  async save(value: T): Promise<T> {
    const cols = this.columns.map((c) => c.column);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const sets = cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
    await this.db.query(
      `INSERT INTO ${this.table} (id, ${cols.join(', ')}, updated_at)
       VALUES (1, ${placeholders}, now())
       ON CONFLICT (id) DO UPDATE SET ${sets}, updated_at = now()`,
      this.columns.map((c) => value[c.key]),
    );
    return this.get();
  }
}
