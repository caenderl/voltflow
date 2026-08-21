import { Logger } from '@nestjs/common';
import type { DeviceRole } from '@org/shared-types';
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
 *
 * `skipIf` is an optional guard query returning a single boolean: true skips
 * the step. It exists for work that cannot express its own "already done" test
 * inside the statement — an expensive backfill whose re-run would be a no-op
 * but still scans the table, or a statement that may not run in a transaction
 * and therefore cannot be wrapped in `DO $$ IF … $$`. A guard is never a
 * substitute for writing the statement idempotently where that is possible.
 */
interface Migration {
  name: string;
  sql: string;
  /** Single-row, single-column boolean query; `true` skips `sql`. */
  skipIf?: string;
}

/**
 * One role view: the same rows as `source`, minus every device that does not
 * carry `role`. Thin on purpose - same columns, same grain, `device_sn` kept -
 * so the callers keep their own windows and counter deltas.
 *
 * Generated rather than hand-written because the role is a string literal
 * inside raw SQL: a typo is invisible to TypeScript *and* to Postgres (the view
 * is created happily, its WHERE just never matches), so the view would return
 * zero rows forever and surface as wrong dashboard numbers, never as an error.
 * Typing the role as DeviceRole moves that failure to compile time, and writing
 * each literal once instead of eight times removes most of the chance to make
 * it in the first place.
 */
function roleView(view: string, source: string, role: DeviceRole): string {
  return `CREATE OR REPLACE VIEW ${view} AS
            SELECT a.* FROM ${source} a
              JOIN device d ON d.device_sn = a.device_sn
             WHERE d.roles @> ARRAY['${role}']::TEXT[]`;
}

/**
 * [migration number, view, source relation, role]. One migration per view, so a
 * failure names the view that broke rather than a bundle it was part of.
 */
const ROLE_VIEWS: readonly (readonly [string, string, string, DeviceRole])[] = [
  ['063', 'producer_readings', 'sma_readings', 'producer'],
  ['064', 'producer_1min', 'sma_1min', 'producer'],
  ['065', 'producer_1hour', 'sma_1hour', 'producer'],
  ['066', 'producer_1day', 'sma_1day', 'producer'],
  ['067', 'grid_meter_readings', 'meter_reading', 'grid-meter'],
  ['068', 'grid_meter_1min', 'meter_1min', 'grid-meter'],
  ['069', 'grid_meter_1hour', 'meter_1hour', 'grid-meter'],
  ['070', 'grid_meter_1day', 'meter_1day', 'grid-meter'],
  ['071', 'consumer_1min', 'wallbox_1min', 'consumer'],
];

const MIGRATIONS: Migration[] = [
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
  // Energy ≈ power × 30 s poll interval (/ 120 000 → kWh) - wrong once
  // poll_interval_s differs from 30s. wallbox_1min is corrected onto a real
  // per-reading energy_wh column by 051-053 below; wallbox_1hour/1day are not
  // (see 053's comment for why).
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
  {
    name: '043-app-settings-table',
    sql: `CREATE TABLE IF NOT EXISTS app_settings (
            id                  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            calibration_enabled BOOLEAN NOT NULL DEFAULT false,
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    // Time-ranged tariffs supersede the single-row `tariff`: each row is valid
    // from its date until the next one starts (one price per start date).
    name: '044-tariff-period-table',
    sql: `CREATE TABLE IF NOT EXISTS tariff_period (
            id            SERIAL PRIMARY KEY,
            valid_from    DATE NOT NULL UNIQUE,
            provider      TEXT,
            import_ct_kwh DOUBLE PRECISION,
            export_ct_kwh DOUBLE PRECISION,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
          )`,
  },
  {
    // One-time seed: carry the old singleton tariff over as the first period so
    // existing costs are unchanged. Guarded by NOT EXISTS so a later restart
    // never resurrects a period the user has since edited or deleted; the
    // oldest period extends backward in the cost logic, so its exact date is
    // immaterial (updated_at, else today).
    name: '045-tariff-period-seed',
    sql: `INSERT INTO tariff_period (valid_from, provider, import_ct_kwh, export_ct_kwh)
          SELECT COALESCE(t.updated_at::date, CURRENT_DATE),
                 t.provider, t.import_ct_kwh, t.export_ct_kwh
            FROM tariff t
           WHERE t.id = 1
             AND (t.provider IS NOT NULL
                  OR t.import_ct_kwh IS NOT NULL
                  OR t.export_ct_kwh IS NOT NULL)
             AND NOT EXISTS (SELECT 1 FROM tariff_period)`,
  },
  {
    // -----------------------------------------------------------------------
    // Tiered retention for the continuous aggregates. The raw hypertables are
    // already pruned (meter_reading 30 d, sma/wallbox_readings 90 d); the
    // aggregates used to be kept for "10 years" (and meter_* had no retention
    // policy at all, growing unbounded). Minute/hour resolution does not need
    // to sit around for a decade: keep 1min for 90 days, 1hour for 2 years,
    // and only the tiny 1day rollups long-term.
    //
    // add_retention_policy(if_not_exists => TRUE) can only ADD a policy, never
    // change an existing interval, so this reconciles idempotently: read the
    // current drop_after and re-create the policy only when it differs from the
    // target (a genuine no-op on every later boot). Non-destructive as long as
    // it is applied while the data is younger than the new window.
    name: '046-aggregate-retention-tiers',
    sql: `DO $$
          DECLARE
            r   record;
            cur interval;
          BEGIN
            FOR r IN
              SELECT * FROM (VALUES
                ('meter_1min',    INTERVAL '90 days'),
                ('meter_1hour',   INTERVAL '2 years'),
                ('meter_1day',    INTERVAL '10 years'),
                ('sma_1min',      INTERVAL '90 days'),
                ('sma_1hour',     INTERVAL '2 years'),
                ('sma_1day',      INTERVAL '10 years'),
                ('wallbox_1min',  INTERVAL '90 days'),
                ('wallbox_1hour', INTERVAL '2 years'),
                ('wallbox_1day',  INTERVAL '10 years')
              ) AS t(view_name, keep)
            LOOP
              cur := NULL;
              SELECT (config->>'drop_after')::interval INTO cur
                FROM timescaledb_information.jobs
               WHERE proc_name = 'policy_retention'
                 AND hypertable_name = r.view_name;
              IF cur IS DISTINCT FROM r.keep THEN
                PERFORM remove_retention_policy(r.view_name::regclass, if_exists => TRUE);
                PERFORM add_retention_policy(r.view_name::regclass, r.keep, if_not_exists => TRUE);
              END IF;
            END LOOP;
          END $$`,
  },
  {
    // Annual base fee (Grundpreis), gross like every other price in the app.
    // Only the billing statement charges it — the day/week/month costs are pure
    // consumption costs, where a per-day share of a standing fee would be noise.
    // Nullable: a tariff without a base fee is a valid tariff.
    name: '047-tariff-period-base-fee',
    sql: `ALTER TABLE tariff_period
            ADD COLUMN IF NOT EXISTS base_eur_per_year DOUBLE PRECISION`,
  },
  {
    // Rebuild of 036: both source caggs are grouped by (device_sn, bucket), so
    // joining them on the bucket alone multiplies rows as soon as a second
    // meter or a second inverter exists - every meter row would match every
    // inverter row of the same minute and the house load would be counted
    // twice over. Each side is now summed to one row per bucket BEFORE the
    // join, which is a no-op with today's single device pair.
    //
    // Extension point (storage): a battery adds two terms to the same shape -
    //   house = PV + import - export + discharge - charge
    // i.e. one more CTE summed per bucket, LEFT JOINed like `pv`, with its two
    // columns folded into house_power. CREATE OR REPLACE keeps the existing
    // column list, so new columns may only be appended.
    name: '048-house-load-view-per-bucket',
    sql: `CREATE OR REPLACE VIEW house_load_1min AS
          WITH grid AS (
            SELECT bucket,
                   sum(grid_to_home_power_avg) AS grid_import,
                   sum(pv_to_grid_power_avg)   AS grid_export
              FROM meter_1min
             GROUP BY bucket
          ), pv AS (
            SELECT bucket, sum(grid_power_avg) AS pv_power
              FROM sma_1min
             GROUP BY bucket
          )
          SELECT
            g.bucket                       AS bucket,
            COALESCE(p.pv_power, 0)        AS pv_power,
            g.grid_import                  AS grid_import,
            g.grid_export                  AS grid_export,
            COALESCE(p.pv_power, 0)
              + COALESCE(g.grid_import, 0)
              - COALESCE(g.grid_export, 0) AS house_power
          FROM grid g
          LEFT JOIN pv p ON p.bucket = g.bucket`,
  },
  // ---------------------------------------------------------------------------
  // Device roles. `device` has been written by the collector since the first
  // release but never read; `type` records which collector registered a device
  // (smartmeter/inverter/wallbox), which is a driver fact, not a domain one.
  // `roles` is what the energy balance actually cares about, and it is an ARRAY
  // because the two are not one-to-one: a hybrid inverter is producer *and*
  // storage, a bidirectional wallbox is consumer *and* producer. Deliberately
  // no CHECK constraint - a role added later (storage) must not need a
  // migration to widen an enum.
  // ---------------------------------------------------------------------------
  {
    name: '049-device-roles',
    sql: `ALTER TABLE device ADD COLUMN IF NOT EXISTS roles TEXT[]`,
  },
  {
    // Seed from the collector's `type`. Touches only NULLs, so re-running never
    // overwrites a role somebody assigned by hand later.
    name: '050-device-roles-backfill',
    sql: `UPDATE device
             SET roles = CASE type
                           WHEN 'smartmeter' THEN ARRAY['grid-meter']
                           WHEN 'inverter'   THEN ARRAY['producer']
                           WHEN 'wallbox'    THEN ARRAY['consumer']
                           ELSE ARRAY[]::TEXT[]
                         END
           WHERE roles IS NULL`,
  },
  // ---------------------------------------------------------------------------
  // Wallbox charged energy: from an assumed poll rate to a measured one.
  //
  // charged_kwh in all three wallbox caggs was `sum(active_power_w) / 120000`,
  // i.e. power x an assumed 30 s sample spacing. poll_interval_s is
  // user-adjustable (5-3600 s), so the figure is wrong by exactly
  // interval/30 whenever it is not 30 s - this deployment polls at 20 s and
  // was reporting ~49 % too much charged energy. The collector now records
  // true per-reading energy in wallbox_reading.energy_wh, measured from the
  // actual elapsed time between polls, and the aggregates simply sum it.
  //
  // The rebuild recomputes each aggregate from the raw hypertable, so it is
  // only safe while the raw retention window still covers the whole
  // aggregate. Each drop below therefore tests exactly that and skips itself
  // otherwise, leaving the old (wrong but present) history alone rather than
  // deleting rows it cannot reproduce - the file's "never DROP data" rule.
  // On this deployment raw data begins 2026-06-25, well inside the 90-day
  // window, so all three rebuild cleanly.
  // ---------------------------------------------------------------------------
  {
    name: '051-wallbox-energy-wh-column',
    sql: `ALTER TABLE wallbox_reading ADD COLUMN IF NOT EXISTS energy_wh DOUBLE PRECISION`,
  },
  {
    // Backfill from each row's ACTUAL recorded spacing (LAG over its own
    // device), capped at 2x the poll interval so a collector outage does not
    // integrate into one implausible spike - the same rule the live collector
    // applies. Without this the rebuilt aggregates would sum NULLs and report
    // zero for every historical bucket.
    //
    // `WHERE energy_wh IS NULL` makes a re-run write nothing, but the LAG
    // window still sorts the whole hypertable (measured: a 7 MB disk-spilling
    // sort on every backend start), so the guard skips the statement outright
    // once no NULLs remain. It re-arms itself if an older collector writes
    // NULL rows again, which is what makes a backend-first deploy self-heal.
    name: '052-wallbox-energy-wh-backfill',
    skipIf: `SELECT NOT EXISTS (SELECT 1 FROM wallbox_reading WHERE energy_wh IS NULL)`,
    sql: `UPDATE wallbox_reading wr
          SET energy_wh = sub.computed_energy_wh
          FROM (
            SELECT wr2.time, wr2.device_sn,
                   CASE WHEN wr2.status = 2 AND wr2.active_power_w IS NOT NULL THEN
                     wr2.active_power_w * COALESCE(LEAST(
                       EXTRACT(EPOCH FROM (wr2.time - LAG(wr2.time)
                         OVER (PARTITION BY wr2.device_sn ORDER BY wr2.time))),
                       2 * COALESCE((SELECT poll_interval_s FROM wallbox_config WHERE id = 1), 30)
                     ), 0) / 3600
                   ELSE 0 END AS computed_energy_wh
              FROM wallbox_reading wr2
          ) sub
          WHERE wr.time = sub.time AND wr.device_sn = sub.device_sn
            AND wr.energy_wh IS NULL`,
  },
  {
    // Drop only if the old formula is still in place AND the raw table still
    // reaches back at least as far as this aggregate does; otherwise the
    // rebuild would silently discard buckets it cannot recompute. An empty
    // aggregate compares as +infinity (nothing to lose -> rebuild); an empty
    // raw table compares as +infinity on the other side (nothing to rebuild
    // from -> keep what is there).
    name: '053-wallbox-1min-drop-old-formula',
    sql: `DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM timescaledb_information.continuous_aggregates
               WHERE view_schema = 'public' AND view_name = 'wallbox_1min'
                 AND view_definition LIKE '%120000%'
            ) THEN
              IF COALESCE((SELECT min(bucket) FROM wallbox_1min), 'infinity'::timestamptz)
                 >= COALESCE((SELECT time_bucket('1 minute', time) FROM wallbox_reading
                               ORDER BY time LIMIT 1), 'infinity'::timestamptz) THEN
                PERFORM remove_retention_policy('wallbox_1min', if_exists => TRUE);
                EXECUTE 'DROP MATERIALIZED VIEW wallbox_1min';
              ELSE
                RAISE WARNING 'wallbox_1min: raw data no longer covers this aggregate - '
                              'keeping the old charged_kwh formula. Rebuild by hand '
                              'from a backup if the figures matter.';
              END IF;
            END IF;
          END $$`,
  },
  {
    // Must be its own statement: CREATE MATERIALIZED VIEW ... WITH DATA is
    // rejected inside a transaction block (and inside DO). WITH DATA rather
    // than WITH NO DATA so the whole history is materialized here, instead of
    // leaving every query before the policy's 3 days start_offset to fall
    // through to a live aggregate over raw for the rest of the retention.
    // IF NOT EXISTS makes it a no-op once built.
    name: '054-wallbox-1min-rebuild',
    sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS wallbox_1min
          WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
          SELECT
            device_sn,
            time_bucket('1 minute', time) AS bucket,
            avg(active_power_w)                                AS avg_power_w,
            max(active_power_w)                                AS max_power_w,
            sum(energy_wh) FILTER (WHERE status = 2) / 1000.0  AS charged_kwh
          FROM wallbox_reading
          GROUP BY device_sn, bucket
          WITH DATA`,
  },
  {
    name: '055-wallbox-1min-policies',
    sql: `SELECT add_continuous_aggregate_policy('wallbox_1min',
            start_offset      => INTERVAL '3 days',
            end_offset        => INTERVAL '1 minute',
            schedule_interval => INTERVAL '1 minute',
            if_not_exists     => TRUE);
          SELECT add_retention_policy('wallbox_1min', INTERVAL '90 days', if_not_exists => TRUE)`,
  },
  {
    // Drop only if the old formula is still in place AND the raw table still
    // reaches back at least as far as this aggregate does; otherwise the
    // rebuild would silently discard buckets it cannot recompute. An empty
    // aggregate compares as +infinity (nothing to lose -> rebuild); an empty
    // raw table compares as +infinity on the other side (nothing to rebuild
    // from -> keep what is there).
    name: '056-wallbox-1hour-drop-old-formula',
    sql: `DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM timescaledb_information.continuous_aggregates
               WHERE view_schema = 'public' AND view_name = 'wallbox_1hour'
                 AND view_definition LIKE '%120000%'
            ) THEN
              IF COALESCE((SELECT min(bucket) FROM wallbox_1hour), 'infinity'::timestamptz)
                 >= COALESCE((SELECT time_bucket('1 hour', time) FROM wallbox_reading
                               ORDER BY time LIMIT 1), 'infinity'::timestamptz) THEN
                PERFORM remove_retention_policy('wallbox_1hour', if_exists => TRUE);
                EXECUTE 'DROP MATERIALIZED VIEW wallbox_1hour';
              ELSE
                RAISE WARNING 'wallbox_1hour: raw data no longer covers this aggregate - '
                              'keeping the old charged_kwh formula. Rebuild by hand '
                              'from a backup if the figures matter.';
              END IF;
            END IF;
          END $$`,
  },
  {
    // Must be its own statement: CREATE MATERIALIZED VIEW ... WITH DATA is
    // rejected inside a transaction block (and inside DO). WITH DATA rather
    // than WITH NO DATA so the whole history is materialized here, instead of
    // leaving every query before the policy's 90 days start_offset to fall
    // through to a live aggregate over raw for the rest of the retention.
    // IF NOT EXISTS makes it a no-op once built.
    name: '057-wallbox-1hour-rebuild',
    sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS wallbox_1hour
          WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
          SELECT
            device_sn,
            time_bucket('1 hour', time) AS bucket,
            avg(active_power_w)                                AS avg_power_w,
            max(active_power_w)                                AS max_power_w,
            sum(energy_wh) FILTER (WHERE status = 2) / 1000.0  AS charged_kwh
          FROM wallbox_reading
          GROUP BY device_sn, bucket
          WITH DATA`,
  },
  {
    name: '058-wallbox-1hour-policies',
    sql: `SELECT add_continuous_aggregate_policy('wallbox_1hour',
            start_offset      => INTERVAL '90 days',
            end_offset        => INTERVAL '1 hour',
            schedule_interval => INTERVAL '1 hour',
            if_not_exists     => TRUE);
          SELECT add_retention_policy('wallbox_1hour', INTERVAL '2 years', if_not_exists => TRUE)`,
  },
  {
    // Drop only if the old formula is still in place AND the raw table still
    // reaches back at least as far as this aggregate does; otherwise the
    // rebuild would silently discard buckets it cannot recompute. An empty
    // aggregate compares as +infinity (nothing to lose -> rebuild); an empty
    // raw table compares as +infinity on the other side (nothing to rebuild
    // from -> keep what is there).
    name: '059-wallbox-1day-drop-old-formula',
    sql: `DO $$
          BEGIN
            IF EXISTS (
              SELECT 1 FROM timescaledb_information.continuous_aggregates
               WHERE view_schema = 'public' AND view_name = 'wallbox_1day'
                 AND view_definition LIKE '%120000%'
            ) THEN
              IF COALESCE((SELECT min(bucket) FROM wallbox_1day), 'infinity'::timestamptz)
                 >= COALESCE((SELECT time_bucket('1 day', time, 'Europe/Berlin') FROM wallbox_reading
                               ORDER BY time LIMIT 1), 'infinity'::timestamptz) THEN
                PERFORM remove_retention_policy('wallbox_1day', if_exists => TRUE);
                EXECUTE 'DROP MATERIALIZED VIEW wallbox_1day';
              ELSE
                RAISE WARNING 'wallbox_1day: raw data no longer covers this aggregate - '
                              'keeping the old charged_kwh formula. Rebuild by hand '
                              'from a backup if the figures matter.';
              END IF;
            END IF;
          END $$`,
  },
  {
    // Must be its own statement: CREATE MATERIALIZED VIEW ... WITH DATA is
    // rejected inside a transaction block (and inside DO). WITH DATA rather
    // than WITH NO DATA so the whole history is materialized here, instead of
    // leaving every query before the policy's 90 days start_offset to fall
    // through to a live aggregate over raw for the rest of the retention.
    // IF NOT EXISTS makes it a no-op once built.
    name: '060-wallbox-1day-rebuild',
    sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS wallbox_1day
          WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
          SELECT
            device_sn,
            time_bucket('1 day', time, 'Europe/Berlin') AS bucket,
            avg(active_power_w)                                AS avg_power_w,
            max(active_power_w)                                AS max_power_w,
            sum(energy_wh) FILTER (WHERE status = 2) / 1000.0  AS charged_kwh
          FROM wallbox_reading
          GROUP BY device_sn, bucket
          WITH DATA`,
  },
  {
    name: '061-wallbox-1day-policies',
    sql: `SELECT add_continuous_aggregate_policy('wallbox_1day',
            start_offset      => INTERVAL '90 days',
            end_offset        => INTERVAL '1 day',
            schedule_interval => INTERVAL '1 hour',
            if_not_exists     => TRUE);
          SELECT add_retention_policy('wallbox_1day', INTERVAL '10 years', if_not_exists => TRUE)`,
  },
  // ---------------------------------------------------------------------------
  // Role-based access to the aggregates.
  //
  // Until now every domain query named a vendor: the house load read `sma_1min`,
  // the statistics read `sma_1hour` and `wallbox_1min`. What those queries
  // actually mean is "every producer", "every consumer", "the grid meter" - and
  // that is what `device.roles` records since 049. These views are the join, so
  // a second inverter (or a storage device later) reaches the domain without
  // touching a single query.
  //
  // They are deliberately thin: same columns, same grain, `device_sn` kept, only
  // the rows filtered. The callers keep their own windows and deltas.
  //
  // The join is strict - a device whose roles are unknown contributes nothing.
  // That is the point (an unclassified device must not silently count as PV),
  // but it does mean the registry has to be right; 062 and the collector's
  // COALESCE seeding are what keep it that way.
  // ---------------------------------------------------------------------------
  {
    // 050 wrote an empty array for a type it had no mapping for. Empty is not
    // NULL, so `COALESCE(device.roles, EXCLUDED.roles)` in the collector could
    // never re-seed such a row once a later version learned that type. Reset
    // those to NULL so the seeding heals them. Touches only empty arrays.
    name: '062-device-roles-empty-to-null',
    sql: `UPDATE device SET roles = NULL WHERE roles = '{}'::TEXT[]`,
  },
  ...ROLE_VIEWS.map(([name, view, source, role]) => ({
    name: `${name}-role-view-${view.replace(/_/g, '-')}`,
    sql: roleView(view, source, role),
  })),
  {
    // Same arithmetic as 048, one level up: the sources are now "every grid
    // meter" and "every producer" rather than two vendor aggregates. Column
    // list unchanged, so CREATE OR REPLACE still applies in place.
    //
    // Storage extends the same shape - one more CTE over a consumer/storage
    // view, folded into house_power as `+ discharge - charge`.
    name: '072-house-load-view-roles',
    sql: `CREATE OR REPLACE VIEW house_load_1min AS
          WITH grid AS (
            SELECT bucket,
                   sum(grid_to_home_power_avg) AS grid_import,
                   sum(pv_to_grid_power_avg)   AS grid_export
              FROM grid_meter_1min
             GROUP BY bucket
          ), pv AS (
            SELECT bucket, sum(grid_power_avg) AS pv_power
              FROM producer_1min
             GROUP BY bucket
          )
          SELECT
            g.bucket                       AS bucket,
            COALESCE(p.pv_power, 0)        AS pv_power,
            g.grid_import                  AS grid_import,
            g.grid_export                  AS grid_export,
            COALESCE(p.pv_power, 0)
              + COALESCE(g.grid_import, 0)
              - COALESCE(g.grid_export, 0) AS house_power
          FROM grid g
          LEFT JOIN pv p ON p.bucket = g.bucket`,
  },
];

export async function applyMigrations(
  pool: Pool,
  logger: Logger = new Logger('Schema'),
): Promise<void> {
  let failed = 0;
  let skipped = 0;
  for (const m of MIGRATIONS) {
    try {
      if (m.skipIf) {
        const { rows } = await pool.query(m.skipIf);
        // Only a definitive `true` skips: an unexpected shape (no row, no
        // column) means the guard could not answer, and running an idempotent
        // statement needlessly is safer than skipping one that was needed.
        if (rows.length && Object.values(rows[0])[0] === true) {
          skipped++;
          continue;
        }
      }
      await pool.query(m.sql);
    } catch (err) {
      failed++;
      logger.error(`migration "${m.name}" failed: ${(err as Error).message}`);
    }
  }
  if (failed === 0) {
    logger.log(
      `Schema up to date (${MIGRATIONS.length} idempotent steps, ${skipped} already satisfied)`,
    );
  } else {
    logger.error(
      `Schema NOT fully applied: ${failed} of ${MIGRATIONS.length} migrations failed`,
    );
  }
}
