import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';

/**
 * Idempotent schema migrations applied on every backend start.
 *
 * Rules to keep data safe across updates:
 *  - `db/init.sql` bootstraps a FRESH database (runs only on an empty volume).
 *  - This list "catches up" EXISTING databases with additive changes and is
 *    safe to re-run, so use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS only.
 *  - Never DROP / rewrite data here. For destructive or data-moving changes
 *    use a real versioned migration tool + a backup first.
 */
const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: '001-tariff-table',
    sql: `CREATE TABLE IF NOT EXISTS tariff (
            id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            provider      TEXT,
            import_ct_kwh DOUBLE PRECISION,
            export_ct_kwh DOUBLE PRECISION,
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  // Future additive changes go here, e.g.:
  // { name: '002-meter-voltage',
  //   sql: 'ALTER TABLE meter_reading ADD COLUMN IF NOT EXISTS voltage DOUBLE PRECISION' },
];

export async function applyMigrations(
  pool: Pool,
  logger: Logger = new Logger('Schema'),
): Promise<void> {
  for (const m of MIGRATIONS) {
    try {
      await pool.query(m.sql);
    } catch (err) {
      logger.error(`migration "${m.name}" failed: ${(err as Error).message}`);
    }
  }
  logger.log(`Schema up to date (${MIGRATIONS.length} idempotent steps)`);
}
