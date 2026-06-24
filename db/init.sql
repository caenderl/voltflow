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
-- (for kWh deltas per range). Real-time aggregation stays on (default), so the
-- current, not-yet-materialized bucket is visible immediately.
-- ---------------------------------------------------------------------------

-- 1-minute buckets -> "day" view
CREATE MATERIALIZED VIEW IF NOT EXISTS meter_1min
WITH (timescaledb.continuous) AS
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
WITH (timescaledb.continuous) AS
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
WITH (timescaledb.continuous) AS
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
