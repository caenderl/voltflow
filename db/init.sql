-- Schema für poke-meter (TimescaleDB).
-- Läuft automatisch beim ersten Start des DB-Containers
-- (gemountet nach /docker-entrypoint-initdb.d/).

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------------
-- Geräte-Registry (vorbereitend; aktuell nur der Smart Meter).
-- Spätere Erweiterung (Wallbox) trägt sich hier ein.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS device (
    device_sn   TEXT PRIMARY KEY,
    device_pn   TEXT,
    type        TEXT,
    alias       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Rohmesswerte vom Smart Meter (~alle 5s ein Insert).
-- time = Ingestion-Zeit (now()), da msg_timestamp unzuverlässig sein kann.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meter_reading (
    time               TIMESTAMPTZ      NOT NULL DEFAULT now(),
    device_sn          TEXT             NOT NULL,
    grid_to_home_power DOUBLE PRECISION,   -- W Bezug (Import aus dem Netz)
    pv_to_grid_power   DOUBLE PRECISION,   -- W Einspeisung / Überschuss
    grid_import_energy DOUBLE PRECISION,   -- kWh kumulativer Zählerstand Bezug
    grid_export_energy DOUBLE PRECISION    -- kWh kumulativer Zählerstand Einspeisung
);

SELECT create_hypertable('meter_reading', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS meter_reading_sn_time_idx
    ON meter_reading (device_sn, time DESC);

-- ---------------------------------------------------------------------------
-- Continuous Aggregates fürs Downsampling der Ansichten.
-- avg/min/max der Leistung; last() der kumulativen Zählerstände
-- (für kWh-Deltas je Zeitraum). Real-time aggregation bleibt an (Default),
-- damit der aktuelle, noch nicht materialisierte Bucket sofort sichtbar ist.
-- ---------------------------------------------------------------------------

-- 1-Minuten-Buckets -> Ansicht "Tag"
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

-- 1-Stunden-Buckets -> Ansicht "Woche"
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

-- 1-Tag-Buckets -> Ansicht "Monat"
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

-- Refresh-Policies (automatisches Nachführen im Hintergrund)
SELECT add_continuous_aggregate_policy('meter_1min',
    start_offset => INTERVAL '3 days',  end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_continuous_aggregate_policy('meter_1hour',
    start_offset => INTERVAL '30 days', end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour');
SELECT add_continuous_aggregate_policy('meter_1day',
    start_offset => INTERVAL '1 year',  end_offset => INTERVAL '1 day',
    schedule_interval => INTERVAL '1 hour');

-- Rohdaten nach 30 Tagen verwerfen (Aggregate bleiben langfristig erhalten)
SELECT add_retention_policy('meter_reading', INTERVAL '30 days');

-- ---------------------------------------------------------------------------
-- NOTIFY-Trigger für Live-Push: jeder Insert sendet die Zeile als JSON
-- auf den Kanal 'meter_reading'. Das NestJS-Backend macht LISTEN darauf.
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
