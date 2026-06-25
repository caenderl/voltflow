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
  {
    name: '002-wallbox-config-table',
    sql: `CREATE TABLE IF NOT EXISTS wallbox_config (
            id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            enabled         BOOLEAN NOT NULL DEFAULT false,
            host            TEXT,
            port            INT     NOT NULL DEFAULT 502,
            unit_id         INT     NOT NULL DEFAULT 1,
            poll_interval_s INT     NOT NULL DEFAULT 30,
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    name: '003-wallbox-reading-table',
    sql: `CREATE TABLE IF NOT EXISTS wallbox_reading (
            time               TIMESTAMPTZ      NOT NULL DEFAULT now(),
            device_sn          TEXT             NOT NULL,
            status             SMALLINT,
            cp_signal          SMALLINT,
            active_power_w     DOUBLE PRECISION,
            session_energy_wh  DOUBLE PRECISION,
            session_duration_s DOUBLE PRECISION,
            l1_current_a       DOUBLE PRECISION,
            l2_current_a       DOUBLE PRECISION,
            l3_current_a       DOUBLE PRECISION,
            l1_voltage_v       DOUBLE PRECISION,
            l2_voltage_v       DOUBLE PRECISION,
            l3_voltage_v       DOUBLE PRECISION
          )`,
  },
  {
    // create_hypertable must be its own statement (no surrounding transaction).
    name: '004-wallbox-reading-hypertable',
    sql: `SELECT create_hypertable('wallbox_reading', 'time', if_not_exists => TRUE)`,
  },
  {
    name: '005-wallbox-reading-index',
    sql: `CREATE INDEX IF NOT EXISTS wallbox_reading_sn_time_idx
            ON wallbox_reading (device_sn, time DESC)`,
  },
  {
    name: '006-wallbox-reading-retention',
    sql: `SELECT add_retention_policy('wallbox_reading', INTERVAL '90 days', if_not_exists => TRUE)`,
  },
  {
    name: '007-wallbox-notify-function',
    sql: `CREATE OR REPLACE FUNCTION notify_wallbox_reading() RETURNS trigger AS $$
          BEGIN
            PERFORM pg_notify('wallbox_reading', row_to_json(NEW)::text);
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql`,
  },
  {
    name: '008-wallbox-notify-trigger',
    sql: `DROP TRIGGER IF EXISTS wallbox_reading_notify ON wallbox_reading;
          CREATE TRIGGER wallbox_reading_notify
            AFTER INSERT ON wallbox_reading
            FOR EACH ROW EXECUTE FUNCTION notify_wallbox_reading()`,
  },
  // Future additive changes go here, e.g.:
  // { name: '009-meter-voltage',
  //   sql: 'ALTER TABLE meter_reading ADD COLUMN IF NOT EXISTS voltage DOUBLE PRECISION' },
];

export async function applyMigrations(
  pool: Pool,
  logger: Logger = new Logger('Schema'),
): Promise<void> {
  let failed = 0;
  for (const m of MIGRATIONS) {
    try {
      await pool.query(m.sql);
    } catch (err) {
      failed++;
      logger.error(`migration "${m.name}" failed: ${(err as Error).message}`);
    }
  }
  if (failed === 0) {
    logger.log(`Schema up to date (${MIGRATIONS.length} idempotent steps)`);
  } else {
    logger.error(
      `Schema NOT fully applied: ${failed} of ${MIGRATIONS.length} migrations failed`,
    );
  }
}
