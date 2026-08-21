import type { DeviceDriver } from '@org/shared-types';
import { DbService } from '../database/db.service';

/**
 * Two persistence shapes for device/app configuration, sharing one column
 * mapping: {@link SingletonConfigStore} for the single-row tables that predate
 * multi-device support, {@link DriverConfigStore} for the `device_config` rows
 * that replace them.
 */

/** One column of a config table, with its DB->TS conversion. */
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

/**
 * Persistence for one row of `device_config`, addressed by its driver.
 *
 * Same column mapping as {@link SingletonConfigStore}, different key: `id = 1`
 * becomes `driver = <driver>`. That is the whole difference while there is one
 * device per driver, and it is what keeps the vendor services (which still
 * speak SmaConfig / WallboxConfig) working unchanged on top of the new table.
 *
 * It is explicitly a *stepping stone*: addressing a config row by its driver
 * can only ever reach one of them, so the second wallbox needs callers that
 * address rows by `id`. Those arrive with the CRUD endpoint in step 3 of this
 * stage; this class exists so the table swap and the API change are separate,
 * reviewable moves rather than one.
 */
export class DriverConfigStore<T extends object> {
  constructor(
    private readonly db: DbService,
    private readonly driver: DeviceDriver,
    private readonly columns: ConfigColumn<T>[],
    private readonly defaults: T,
  ) {}

  async get(): Promise<T> {
    const cols = this.columns.map((c) => c.column).join(', ');
    const { rows } = await this.db.query(
      `SELECT ${cols} FROM device_config WHERE driver = $1 ORDER BY id LIMIT 1`,
      [this.driver],
    );
    if (!rows.length) return { ...this.defaults };
    const row = rows[0];
    const out = { ...this.defaults };
    for (const c of this.columns) {
      out[c.key] = c.fromDb(row[c.column]) as T[keyof T];
    }
    return out;
  }

  /**
   * Updates the driver's row. Deliberately UPDATE-only: there is no INSERT
   * path, and that is the whole defence against duplicate rows.
   *
   * An "update, else insert" pair cannot be made safe here. `driver` is not
   * unique (two wallboxes are two rows with the same driver), so there is no
   * conflict target for an upsert and no constraint to catch a double insert;
   * two concurrent first-saves would each find no row and each create one.
   * That is reachable - the settings form's submit button has no pending
   * guard, so a double click is two requests. The migrations therefore
   * guarantee a row per known driver at boot (see seedDeviceConfig), which
   * leaves nothing for save() to create.
   *
   * Throwing when no row matched is the point: with the seed in place it can
   * only mean a driver nobody seeded, and failing loudly beats silently
   * writing a row that a second caller could duplicate.
   */
  async save(value: T): Promise<T> {
    const cols = this.columns.map((c) => c.column);
    const params = this.columns.map((c) => value[c.key]);
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');

    // RETURNING rather than a row count: DbService.query exposes only `rows`.
    const { rows: updated } = await this.db.query(
      `UPDATE device_config
          SET ${sets}, updated_at = now()
        WHERE id = (SELECT id FROM device_config
                     WHERE driver = $${cols.length + 1}
                     ORDER BY id LIMIT 1)
        RETURNING id`,
      [...params, this.driver],
    );

    if (!updated.length) {
      throw new Error(
        `no device_config row for driver "${this.driver}" - it should have ` +
          `been seeded at startup`,
      );
    }
    return this.get();
  }
}
