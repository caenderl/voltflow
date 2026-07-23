import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';

/**
 * Idempotent schema migrations applied on every backend start.
 *
 * Rules to keep data safe across updates:
 *  - `db/init.sql` bootstraps a FRESH database (runs only on an empty volume).
 *  - This list "catches up" EXISTING databases with additive changes and is
 *    safe to re-run, so every statement must be a no-op the second time:
 *    IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, or a statement that is already
 *    satisfied (a backfill scoped by `WHERE col IS NULL`, a SET NOT NULL on a
 *    column that has no nulls left). Tightening a constraint that way needs
 *    its backfill as a separate, earlier entry — see 040-042.
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
  {
    name: '009-wallbox-config-name',
    sql: `ALTER TABLE wallbox_config ADD COLUMN IF NOT EXISTS name TEXT`,
  },
  // ---------------------------------------------------------------------------
  // Wallbox continuous aggregates (added after initial release).
  // Energy ≈ power × 30 s poll interval (/ 120 000 → kWh).
  // ---------------------------------------------------------------------------
  {
    name: '010-wallbox-1min-aggregate',
    sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS wallbox_1min
          WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
          SELECT
            device_sn,
            time_bucket('1 minute', time)                             AS bucket,
            avg(active_power_w)                                       AS avg_power_w,
            max(active_power_w)                                       AS max_power_w,
            sum(active_power_w) FILTER (WHERE status = 2) / 120000.0 AS charged_kwh
          FROM wallbox_reading
          GROUP BY device_sn, bucket
          WITH NO DATA`,
  },
  {
    name: '011-wallbox-1min-policy',
    sql: `SELECT add_continuous_aggregate_policy('wallbox_1min',
            start_offset      => INTERVAL '3 days',
            end_offset        => INTERVAL '1 minute',
            schedule_interval => INTERVAL '1 minute',
            if_not_exists     => TRUE)`,
  },
  {
    name: '012-wallbox-1min-retention',
    sql: `SELECT add_retention_policy('wallbox_1min', INTERVAL '10 years', if_not_exists => TRUE)`,
  },
  {
    name: '013-wallbox-1hour-aggregate',
    sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS wallbox_1hour
          WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
          SELECT
            device_sn,
            time_bucket('1 hour', time)                               AS bucket,
            avg(active_power_w)                                       AS avg_power_w,
            max(active_power_w)                                       AS max_power_w,
            sum(active_power_w) FILTER (WHERE status = 2) / 120000.0 AS charged_kwh
          FROM wallbox_reading
          GROUP BY device_sn, bucket
          WITH NO DATA`,
  },
  {
    name: '014-wallbox-1hour-policy',
    sql: `SELECT add_continuous_aggregate_policy('wallbox_1hour',
            start_offset      => INTERVAL '90 days',
            end_offset        => INTERVAL '1 hour',
            schedule_interval => INTERVAL '1 hour',
            if_not_exists     => TRUE)`,
  },
  {
    name: '015-wallbox-1hour-retention',
    sql: `SELECT add_retention_policy('wallbox_1hour', INTERVAL '10 years', if_not_exists => TRUE)`,
  },
  {
    name: '016-wallbox-1day-aggregate',
    // Timezone-aware bucketing so day boundaries align with CET/CEST midnight.
    sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS wallbox_1day
          WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
          SELECT
            device_sn,
            time_bucket('1 day', time, 'Europe/Berlin')               AS bucket,
            avg(active_power_w)                                       AS avg_power_w,
            max(active_power_w)                                       AS max_power_w,
            sum(active_power_w) FILTER (WHERE status = 2) / 120000.0 AS charged_kwh
          FROM wallbox_reading
          GROUP BY device_sn, bucket
          WITH NO DATA`,
  },
  {
    name: '017-wallbox-1day-policy',
    sql: `SELECT add_continuous_aggregate_policy('wallbox_1day',
            start_offset      => INTERVAL '90 days',
            end_offset        => INTERVAL '1 day',
            schedule_interval => INTERVAL '1 hour',
            if_not_exists     => TRUE)`,
  },
  {
    name: '018-wallbox-1day-retention',
    sql: `SELECT add_retention_policy('wallbox_1day', INTERVAL '10 years', if_not_exists => TRUE)`,
  },
  {
    // Enable real-time aggregation on all continuous aggregates so the current,
    // not-yet-materialized bucket is visible immediately. TimescaleDB >= 2.13
    // defaults materialized_only to TRUE, which silently hides today's data
    // (e.g. the wallbox daily energy view returned nothing). Idempotent.
    name: '019-caggs-realtime-aggregation',
    sql: `ALTER MATERIALIZED VIEW meter_1min    SET (timescaledb.materialized_only = false);
          ALTER MATERIALIZED VIEW meter_1hour   SET (timescaledb.materialized_only = false);
          ALTER MATERIALIZED VIEW meter_1day    SET (timescaledb.materialized_only = false);
          ALTER MATERIALIZED VIEW wallbox_1min  SET (timescaledb.materialized_only = false);
          ALTER MATERIALIZED VIEW wallbox_1hour SET (timescaledb.materialized_only = false);
          ALTER MATERIALIZED VIEW wallbox_1day  SET (timescaledb.materialized_only = false)`,
  },
  // --- SMA PV inverter ------------------------------------------------------
  {
    name: '020-sma-config-table',
    sql: `CREATE TABLE IF NOT EXISTS sma_config (
            id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            enabled         BOOLEAN NOT NULL DEFAULT false,
            name            TEXT,
            host            TEXT,
            poll_interval_s INT     NOT NULL DEFAULT 60,
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    name: '021-sma-readings-table',
    sql: `CREATE TABLE IF NOT EXISTS sma_readings (
            time            TIMESTAMPTZ      NOT NULL DEFAULT now(),
            device_sn       TEXT             NOT NULL,
            asleep          BOOLEAN          NOT NULL DEFAULT false,
            grid_power      DOUBLE PRECISION,
            pv_power_a      DOUBLE PRECISION,
            pv_power_b      DOUBLE PRECISION,
            daily_yield_wh  DOUBLE PRECISION,
            total_yield_kwh DOUBLE PRECISION,
            power_l1        DOUBLE PRECISION,
            power_l2        DOUBLE PRECISION,
            power_l3        DOUBLE PRECISION,
            pv_voltage_a    DOUBLE PRECISION,
            pv_voltage_b    DOUBLE PRECISION,
            pv_current_a    DOUBLE PRECISION,
            pv_current_b    DOUBLE PRECISION,
            voltage_l1      DOUBLE PRECISION,
            voltage_l2      DOUBLE PRECISION,
            voltage_l3      DOUBLE PRECISION,
            frequency       DOUBLE PRECISION,
            temp_a          DOUBLE PRECISION,
            status          INTEGER
          )`,
  },
  {
    name: '022-sma-readings-hypertable',
    sql: `SELECT create_hypertable('sma_readings', 'time', if_not_exists => TRUE)`,
  },
  {
    name: '023-sma-readings-index',
    sql: `CREATE INDEX IF NOT EXISTS sma_readings_sn_time_idx
            ON sma_readings (device_sn, time DESC)`,
  },
  {
    name: '024-sma-readings-retention',
    sql: `SELECT add_retention_policy('sma_readings', INTERVAL '90 days', if_not_exists => TRUE)`,
  },
  {
    name: '025-sma-notify-function',
    sql: `CREATE OR REPLACE FUNCTION notify_sma_reading() RETURNS trigger AS $$
          BEGIN
            PERFORM pg_notify('sma_reading', row_to_json(NEW)::text);
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql`,
  },
  {
    name: '026-sma-notify-trigger',
    sql: `DROP TRIGGER IF EXISTS sma_reading_notify ON sma_readings;
          CREATE TRIGGER sma_reading_notify
            AFTER INSERT ON sma_readings
            FOR EACH ROW EXECUTE FUNCTION notify_sma_reading()`,
  },
  {
    name: '027-sma-1min-aggregate',
    sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS sma_1min
          WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
          SELECT
            device_sn,
            time_bucket('1 minute', time) AS bucket,
            avg(grid_power)               AS grid_power_avg,
            max(grid_power)               AS grid_power_max,
            max(daily_yield_wh)           AS daily_yield_wh,
            last(total_yield_kwh, time)   AS total_yield_kwh
          FROM sma_readings
          GROUP BY device_sn, bucket
          WITH NO DATA`,
  },
  {
    name: '028-sma-1min-policy',
    sql: `SELECT add_continuous_aggregate_policy('sma_1min',
            start_offset => INTERVAL '3 days', end_offset => INTERVAL '1 minute',
            schedule_interval => INTERVAL '1 minute', if_not_exists => TRUE)`,
  },
  {
    name: '029-sma-1min-retention',
    sql: `SELECT add_retention_policy('sma_1min', INTERVAL '10 years', if_not_exists => TRUE)`,
  },
  {
    name: '030-sma-1hour-aggregate',
    sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS sma_1hour
          WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
          SELECT
            device_sn,
            time_bucket('1 hour', time)   AS bucket,
            avg(grid_power)               AS grid_power_avg,
            max(grid_power)               AS grid_power_max,
            max(daily_yield_wh)           AS daily_yield_wh,
            last(total_yield_kwh, time)   AS total_yield_kwh
          FROM sma_readings
          GROUP BY device_sn, bucket
          WITH NO DATA`,
  },
  {
    name: '031-sma-1hour-policy',
    sql: `SELECT add_continuous_aggregate_policy('sma_1hour',
            start_offset => INTERVAL '90 days', end_offset => INTERVAL '1 hour',
            schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE)`,
  },
  {
    name: '032-sma-1hour-retention',
    sql: `SELECT add_retention_policy('sma_1hour', INTERVAL '10 years', if_not_exists => TRUE)`,
  },
  {
    name: '033-sma-1day-aggregate',
    sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS sma_1day
          WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
          SELECT
            device_sn,
            time_bucket('1 day', time, 'Europe/Berlin') AS bucket,
            avg(grid_power)               AS grid_power_avg,
            max(grid_power)               AS grid_power_max,
            max(daily_yield_wh)           AS daily_yield_wh,
            last(total_yield_kwh, time)   AS total_yield_kwh
          FROM sma_readings
          GROUP BY device_sn, bucket
          WITH NO DATA`,
  },
  {
    name: '034-sma-1day-policy',
    sql: `SELECT add_continuous_aggregate_policy('sma_1day',
            start_offset => INTERVAL '90 days', end_offset => INTERVAL '1 day',
            schedule_interval => INTERVAL '1 hour', if_not_exists => TRUE)`,
  },
  {
    name: '035-sma-1day-retention',
    sql: `SELECT add_retention_policy('sma_1day', INTERVAL '10 years', if_not_exists => TRUE)`,
  },
  {
    // House load on a common 1-min grid. Caggs cannot JOIN hypertables, so this
    // is a plain view combining meter_1min + sma_1min: house = PV + import - export.
    name: '036-house-load-view',
    sql: `CREATE OR REPLACE VIEW house_load_1min AS
          SELECT
            m.bucket                                AS bucket,
            COALESCE(s.grid_power_avg, 0)           AS pv_power,
            m.grid_to_home_power_avg                AS grid_import,
            m.pv_to_grid_power_avg                  AS grid_export,
            COALESCE(s.grid_power_avg, 0)
              + COALESCE(m.grid_to_home_power_avg, 0)
              - COALESCE(m.pv_to_grid_power_avg, 0) AS house_power
          FROM meter_1min m
          LEFT JOIN sma_1min s ON s.bucket = m.bucket`,
  },
  {
    // Manually entered meter checkpoints (Zählerstände), used to validate the
    // smart meter's cumulative readings against the physical meter.
    name: '037-meter-checkpoint-table',
    sql: `CREATE TABLE IF NOT EXISTS meter_checkpoint (
            id          SERIAL PRIMARY KEY,
            date        DATE             NOT NULL,
            import_kwh  DOUBLE PRECISION NOT NULL,
            export_kwh  DOUBLE PRECISION NOT NULL,
            created_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
          )`,
  },
  {
    name: '038-meter-checkpoint-date-index',
    sql: `CREATE INDEX IF NOT EXISTS meter_checkpoint_date_idx
            ON meter_checkpoint (date DESC)`,
  },
  {
    // One reading per day: two checkpoints on the same date describe the same
    // physical counter twice, which yields 0-day intervals and a meaningless
    // deviation in the reconciliation. Additive and idempotent; on a database
    // that already holds duplicates this step fails and is logged, leaving the
    // duplicates to be cleaned up by hand rather than dropping any row here.
    name: '039-meter-checkpoint-date-unique',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS meter_checkpoint_date_uniq
            ON meter_checkpoint (date)`,
  },
  // ---------------------------------------------------------------------------
  // Time of day a checkpoint was read. Before this the reconciliation assumed
  // 18:00, which skews the projection whenever the meter is read at another
  // hour. Split into three steps because NOT NULL cannot be added to a table
  // with existing rows in one go; each step is individually idempotent.
  // ---------------------------------------------------------------------------
  {
    name: '040-meter-checkpoint-read-at',
    sql: `ALTER TABLE meter_checkpoint ADD COLUMN IF NOT EXISTS read_at TIME`,
  },
  {
    // Backfill with the hour the reconciliation assumed until now, so existing
    // rows keep the meaning they were compared under. Touches only NULLs, so
    // re-running never overwrites a time somebody entered.
    name: '041-meter-checkpoint-read-at-backfill',
    sql: `UPDATE meter_checkpoint SET read_at = '18:00' WHERE read_at IS NULL`,
  },
  {
    // Deliberately no DEFAULT: the reading time must be a stated fact, not a
    // silent assumption filled in by the database.
    name: '042-meter-checkpoint-read-at-not-null',
    sql: `ALTER TABLE meter_checkpoint ALTER COLUMN read_at SET NOT NULL`,
  },
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
