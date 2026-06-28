"""
db.py - asyncpg connection to TimescaleDB for the collector.
"""

import logging
import os

import asyncpg

LOG = logging.getLogger("voltflow.db")

# Float fields in the snapshot (come from the API as strings)
_FLOAT_FIELDS = (
    "grid_to_home_power",
    "pv_to_grid_power",
    "grid_import_energy",
    "grid_export_energy",
)


def _to_float(value) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


async def create_pool() -> asyncpg.Pool:
    dsn = os.getenv("DATABASE_URL")
    if not dsn:
        raise RuntimeError("DATABASE_URL not set (env or .env).")
    LOG.info("Connecting to DB: %s", dsn.rsplit("@", 1)[-1])
    return await asyncpg.create_pool(dsn, min_size=1, max_size=4)


async def register_device(pool: asyncpg.Pool, snapshot: dict, dev: dict | None = None) -> None:
    """Register the device in the device registry (idempotent)."""
    dev = dev or {}
    await pool.execute(
        """
        INSERT INTO device (device_sn, device_pn, type, alias)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (device_sn) DO UPDATE
            SET device_pn = EXCLUDED.device_pn,
                type      = EXCLUDED.type,
                alias     = EXCLUDED.alias
        """,
        snapshot.get("device_sn"),
        dev.get("device_pn"),
        dev.get("type"),
        dev.get("alias") or dev.get("name"),
    )


async def insert_reading(pool: asyncpg.Pool, snapshot: dict) -> None:
    """Store a smart meter snapshot as a measurement row."""
    await pool.execute(
        """
        INSERT INTO meter_reading (
            device_sn, grid_to_home_power, pv_to_grid_power,
            grid_import_energy, grid_export_energy
        ) VALUES ($1, $2, $3, $4, $5)
        """,
        snapshot.get("device_sn"),
        *[_to_float(snapshot.get(f)) for f in _FLOAT_FIELDS],
    )


# --- Wallbox -------------------------------------------------------------

# Numeric fields of a wallbox snapshot (in INSERT column order)
_WALLBOX_FIELDS = (
    "status",
    "cp_signal",
    "active_power_w",
    "session_energy_wh",
    "session_duration_s",
    "l1_current_a",
    "l2_current_a",
    "l3_current_a",
    "l1_voltage_v",
    "l2_voltage_v",
    "l3_voltage_v",
)


async def read_wallbox_config(pool: asyncpg.Pool) -> dict | None:
    """Return the wallbox config row, or None if not configured / table missing.

    The collector reads this once at startup to decide whether to poll the
    wallbox at all.
    """
    try:
        row = await pool.fetchrow(
            "SELECT enabled, host, port, unit_id, poll_interval_s "
            "FROM wallbox_config WHERE id = 1"
        )
    except asyncpg.UndefinedTableError:
        # Backend has not applied migrations yet -> treat as not configured.
        return None
    if row is None:
        return None
    return dict(row)


async def register_wallbox(pool: asyncpg.Pool, snapshot: dict) -> None:
    """Register the wallbox in the device registry (idempotent)."""
    await pool.execute(
        """
        INSERT INTO device (device_sn, device_pn, type, alias)
        VALUES ($1, $2, 'wallbox', $3)
        ON CONFLICT (device_sn) DO UPDATE
            SET device_pn = EXCLUDED.device_pn,
                type      = EXCLUDED.type
        """,
        snapshot.get("device_sn"),
        snapshot.get("device_pn"),
        snapshot.get("device_pn"),
    )


async def insert_wallbox_reading(pool: asyncpg.Pool, snapshot: dict) -> None:
    """Store a wallbox snapshot as a measurement row."""
    await pool.execute(
        """
        INSERT INTO wallbox_reading (
            device_sn, status, cp_signal, active_power_w,
            session_energy_wh, session_duration_s,
            l1_current_a, l2_current_a, l3_current_a,
            l1_voltage_v, l2_voltage_v, l3_voltage_v
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        """,
        snapshot.get("device_sn"),
        *[snapshot.get(f) for f in _WALLBOX_FIELDS],
    )


# --- SMA inverter --------------------------------------------------------

# Numeric fields of an SMA snapshot (in INSERT column order, after device_sn+asleep)
_SMA_FIELDS = (
    "grid_power",
    "pv_power_a",
    "pv_power_b",
    "daily_yield_wh",
    "total_yield_kwh",
    "power_l1",
    "power_l2",
    "power_l3",
    "pv_voltage_a",
    "pv_voltage_b",
    "pv_current_a",
    "pv_current_b",
    "voltage_l1",
    "voltage_l2",
    "voltage_l3",
    "frequency",
    "temp_a",
    "status",
)


async def read_sma_config(pool: asyncpg.Pool) -> dict | None:
    """Return the SMA config row, or None if not configured / table missing."""
    try:
        row = await pool.fetchrow(
            "SELECT enabled, host, poll_interval_s FROM sma_config WHERE id = 1"
        )
    except asyncpg.UndefinedTableError:
        return None
    if row is None:
        return None
    return dict(row)


async def last_sma_reading(pool: asyncpg.Pool) -> dict | None:
    """Most recent SMA reading (for seeding the daily_yield carry after a
    restart and for writing asleep rows when the inverter is unreachable)."""
    try:
        row = await pool.fetchrow(
            "SELECT time, device_sn, device_pn, daily_yield_wh, total_yield_kwh "
            "FROM sma_readings r "
            "LEFT JOIN device d ON d.device_sn = r.device_sn "
            "ORDER BY time DESC LIMIT 1"
        )
    except asyncpg.UndefinedTableError:
        return None
    return dict(row) if row else None


async def register_sma(pool: asyncpg.Pool, snapshot: dict) -> None:
    """Register the inverter in the device registry (idempotent)."""
    await pool.execute(
        """
        INSERT INTO device (device_sn, device_pn, type, alias)
        VALUES ($1, $2, 'inverter', $3)
        ON CONFLICT (device_sn) DO UPDATE
            SET device_pn = EXCLUDED.device_pn,
                type      = EXCLUDED.type
        """,
        snapshot.get("device_sn"),
        snapshot.get("device_pn"),
        snapshot.get("device_pn"),
    )


async def insert_sma_reading(pool: asyncpg.Pool, snapshot: dict) -> None:
    """Store an SMA snapshot as a measurement row."""
    await pool.execute(
        """
        INSERT INTO sma_readings (
            device_sn, asleep, grid_power, pv_power_a, pv_power_b,
            daily_yield_wh, total_yield_kwh, power_l1, power_l2, power_l3,
            pv_voltage_a, pv_voltage_b, pv_current_a, pv_current_b,
            voltage_l1, voltage_l2, voltage_l3, frequency, temp_a, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                  $15, $16, $17, $18, $19, $20)
        """,
        snapshot.get("device_sn"),
        bool(snapshot.get("asleep", False)),
        *[snapshot.get(f) for f in _SMA_FIELDS],
    )
