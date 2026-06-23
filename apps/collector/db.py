"""
db.py - asyncpg-Anbindung an die TimescaleDB fuer den Collector.
"""

import logging
import os

import asyncpg

LOG = logging.getLogger("poke.db")

# Float-Felder im Snapshot (kommen von der API als Strings)
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
        raise RuntimeError("DATABASE_URL nicht gesetzt (env oder .env).")
    LOG.info("Verbinde zur DB: %s", dsn.rsplit("@", 1)[-1])
    return await asyncpg.create_pool(dsn, min_size=1, max_size=4)


async def register_device(pool: asyncpg.Pool, snapshot: dict, dev: dict | None = None) -> None:
    """Geraet in die device-Registry eintragen (idempotent)."""
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
    """Einen Smart-Meter-Snapshot als Messwert speichern."""
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
