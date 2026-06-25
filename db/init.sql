-- Schema for Voltflow (TimescaleDB).
-- Runs automatically on the first start of the DB container
-- (mounted into /docker-entrypoint-initdb.d/).

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------------
-- Device registry (preparatory; currently only the smart meter).
-- A future extension (wallbox) registers itself here.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device (
    device_sn   TEXT PRIMARY KEY,
    device_pn   TEXT,
    type        TEXT,
    alias       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Single-row electricity tariff (work prices in ct/kWh).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tariff (
    id            INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    provider      TEXT,
    import_ct_kwh DOUBLE PRECISION,
    export_ct_kwh DOUBLE PRECISION,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Single-row wallbox connection config (Anker SOLIX V1 / A5191, Modbus TCP).
-- The collector only polls the wallbox when enabled = true and host is set.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallbox_config (
    id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled         BOOLEAN NOT NULL DEFAULT false,
    name            TEXT,
    host            TEXT,
    port            INT     NOT NULL DEFAULT 502,
    unit_id         INT     NOT NULL DEFAULT 1,
    poll_interval_s INT     NOT NULL DEFAULT 30,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Raw smart meter readings (~one insert every 5s).
-- time = ingestion time (now()), since msg_timestamp can be unreliable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meter_reading (
    time               TIMESTAMPTZ      NOT NULL DEFAULT now(),
    device_sn          TEXT             NOT NULL,
    grid_to_home_power DOUBLE PRECISION,   -- W grid import
    pv_to_grid_power   DOUBLE PRECISION,   -- W feed-in / surplus
    grid_import_energy DOUBLE PRECISION,   -- kWh cumulative import meter reading
    grid_export_energy DOUBLE PRECISION    -- kWh cumulative export meter reading
);

SELECT create_hypertable('meter_reading', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS meter_reading_sn_time_idx
    ON meter_reading (device_sn, time DESC);

-- ---------------------------------------------------------------------------
-- Continuous aggregates for downsampling the views.
-- avg/min/max of power; last() of the cumulative meter readings
-- (for kWh deltas per range). Real-time aggregation is enabled explicitly
-- (materialized_only = false) so the current, not-yet-materialized bucket is
-- visible immediately. NOTE: TimescaleDB >= 2.13 defaults this to true, so it
-- must be set explicitly here.
-- ---------------------------------------------------------------------------

-- 1-minute buckets -> "day" view
CREATE MATERIALIZED VIEW IF NOT EXISTS meter_1min
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    device_sn,
    time_bucket('1 minute', time)            AS bucket,
    avg(grid_to_home_power)                  AS grid_to_home_power_avg,
    max(grid_to_home_power)                  AS grid_to_home_power_max,
    avg(pv_to_grid_power)                    AS pv_to_grid_power_avg,
    max(pv_to_grid_power)                    AS pv_to_grid_power_max,
    last(grid_import_energy, time)           AS grid_import_energy,
    last(grid_export_energy, time)           AS grid_export_energy
FROM meter_reading
GROUP BY device_sn, bucket
WITH NO DATA;

-- 1-hour buckets -> "week" view
CREATE MATERIALIZED VIEW IF NOT EXISTS meter_1hour
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    device_sn,
    time_bucket('1 hour', time)              AS bucket,
    avg(grid_to_home_power)                  AS grid_to_home_power_avg,
    max(grid_to_home_power)                  AS grid_to_home_power_max,
    avg(pv_to_grid_power)                    AS pv_to_grid_power_avg,
    max(pv_to_grid_power)                    AS pv_to_grid_power_max,
    last(grid_import_energy, time)           AS grid_import_energy,
    last(grid_export_energy, time)           AS grid_export_energy
FROM meter_reading
GROUP BY device_sn, bucket
WITH NO DATA;

-- 1-day buckets -> "month" view
CREATE MATERIALIZED VIEW IF NOT EXISTS meter_1day
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    device_sn,
    time_bucket('1 day', time)               AS bucket,
    avg(grid_to_home_power)                  AS grid_to_home_power_avg,
    max(grid_to_home_power)                  AS grid_to_home_power_max,
    avg(pv_to_grid_power)                    AS pv_to_grid_power_avg,
    max(pv_to_grid_power)                    AS pv_to_grid_power_max,
    last(grid_import_energy, time)           AS grid_import_energy,
    last(grid_export_energy, time)           AS grid_export_energy
FROM meter_reading
GROUP BY device_sn, bucket
WITH NO DATA;

-- Refresh policies (automatic background updates)
SELECT add_continuous_aggregate_policy('meter_1min',
    start_offset => INTERVAL '3 days',  end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('meter_1hour',
    start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');
SELECT add_continuous_aggregate_policy('meter_1day',
    start_offset => INTERVAL '1 year',  end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 hour');

-- Drop raw data after 30 days (aggregates are kept long-term)
SELECT add_retention_policy('meter_reading', INTERVAL '30 days');

-- ---------------------------------------------------------------------------
-- NOTIFY trigger for the live push: every insert sends the row as JSON on the
-- 'meter_reading' channel. The NestJS backend LISTENs on it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION notify_meter_reading() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('meter_reading', row_to_json(NEW)::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS meter_reading_notify ON meter_reading;
CREATE TRIGGER meter_reading_notify
    AFTER INSERT ON meter_reading
    FOR EACH ROW EXECUTE FUNCTION notify_meter_reading();

-- ---------------------------------------------------------------------------
-- Raw wallbox readings (one insert per poll interval, default ~30s).
-- time = ingestion time (now()).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wallbox_reading (
    time               TIMESTAMPTZ      NOT NULL DEFAULT now(),
    device_sn          TEXT             NOT NULL,
    status             SMALLINT,            -- charging status (reg 20097)
    cp_signal          SMALLINT,            -- CP signal state (reg 20092)
    active_power_w     DOUBLE PRECISION,    -- total charging active power, W
    session_energy_wh  DOUBLE PRECISION,    -- current session energy, Wh
    session_duration_s DOUBLE PRECISION,    -- current session duration, s
    l1_current_a       DOUBLE PRECISION,
    l2_current_a       DOUBLE PRECISION,
    l3_current_a       DOUBLE PRECISION,
    l1_voltage_v       DOUBLE PRECISION,
    l2_voltage_v       DOUBLE PRECISION,
    l3_voltage_v       DOUBLE PRECISION
);

SELECT create_hypertable('wallbox_reading', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS wallbox_reading_sn_time_idx
    ON wallbox_reading (device_sn, time DESC);

-- Drop raw data after 90 days (aggregates below are kept long-term).
SELECT add_retention_policy('wallbox_reading', INTERVAL '90 days', if_not_exists => TRUE);

-- ---------------------------------------------------------------------------
-- Continuous aggregates for downsampling wallbox readings.
-- Energy is approximated as power × 30 s poll interval (/ 120 000 → kWh).
-- Real-time aggregation is enabled explicitly (materialized_only = false) so the
-- current bucket is visible (TimescaleDB >= 2.13 defaults this to true).
-- ---------------------------------------------------------------------------

-- 1-minute buckets (UTC) — groundwork for a future "day" power chart
CREATE MATERIALIZED VIEW IF NOT EXISTS wallbox_1min
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    device_sn,
    time_bucket('1 minute', time)                                AS bucket,
    avg(active_power_w)                                          AS avg_power_w,
    max(active_power_w)                                          AS max_power_w,
    sum(active_power_w) FILTER (WHERE status = 2) / 120000.0    AS charged_kwh
FROM wallbox_reading
GROUP BY device_sn, bucket
WITH NO DATA;

-- 1-hour buckets (UTC) — groundwork for a future "week" power chart
CREATE MATERIALIZED VIEW IF NOT EXISTS wallbox_1hour
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    device_sn,
    time_bucket('1 hour', time)                                  AS bucket,
    avg(active_power_w)                                          AS avg_power_w,
    max(active_power_w)                                          AS max_power_w,
    sum(active_power_w) FILTER (WHERE status = 2) / 120000.0    AS charged_kwh
FROM wallbox_reading
GROUP BY device_sn, bucket
WITH NO DATA;

-- 1-day buckets (Berlin local time) — used by the monthly charged-energy chart.
-- Timezone-aware so day boundaries align with CET/CEST midnight, not UTC.
CREATE MATERIALIZED VIEW IF NOT EXISTS wallbox_1day
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT
    device_sn,
    time_bucket('1 day', time, 'Europe/Berlin')                  AS bucket,
    avg(active_power_w)                                          AS avg_power_w,
    max(active_power_w)                                          AS max_power_w,
    sum(active_power_w) FILTER (WHERE status = 2) / 120000.0    AS charged_kwh
FROM wallbox_reading
GROUP BY device_sn, bucket
WITH NO DATA;

-- Refresh policies
SELECT add_continuous_aggregate_policy('wallbox_1min',
    start_offset      => INTERVAL '3 days',
    end_offset        => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('wallbox_1hour',
    start_offset      => INTERVAL '90 days',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');
SELECT add_continuous_aggregate_policy('wallbox_1day',
    start_offset      => INTERVAL '90 days',
    end_offset        => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 hour');

-- Retain aggregated data for 10 years (raw wallbox_reading stays at 90 days)
SELECT add_retention_policy('wallbox_1min',  INTERVAL '10 years', if_not_exists => TRUE);
SELECT add_retention_policy('wallbox_1hour', INTERVAL '10 years', if_not_exists => TRUE);
SELECT add_retention_policy('wallbox_1day',  INTERVAL '10 years', if_not_exists => TRUE);

-- NOTIFY trigger for the live wallbox push (backend LISTENs 'wallbox_reading').
CREATE OR REPLACE FUNCTION notify_wallbox_reading() RETURNS trigger AS $$
BEGIN
    PERFORM pg_notify('wallbox_reading', row_to_json(NEW)::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallbox_reading_notify ON wallbox_reading;
CREATE TRIGGER wallbox_reading_notify
    AFTER INSERT ON wallbox_reading
    FOR EACH ROW EXECUTE FUNCTION notify_wallbox_reading();
