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


# What each collector's devices do in the energy balance. `type` says which
# collector registered a device; `roles` says what the domain should make of it,
# and the two are not one-to-one (a hybrid inverter would be producer+storage).
# Only used to seed a device the first time - see register_device.
_ROLES_BY_TYPE = {
    "smartmeter": ["grid-meter"],
    "inverter": ["producer"],
    "wallbox": ["consumer"],
}


async def register_device(pool: asyncpg.Pool, snapshot: dict, device_type: str | None = None) -> None:
    """Register a device in the device registry (idempotent, any device type).

    `roles` is only ever *seeded* here (COALESCE keeps whatever is already
    stored): the collector knows which stream it opened, not how the household
    classifies the device, so a role corrected later must survive the next
    registration.

    An unmapped type seeds NULL, not an empty array. COALESCE only fills a NULL,
    so writing `{}` here would freeze the device as role-less forever - a later
    version that learns the type could never seed it. NULL leaves the slot open.
    """
    await pool.execute(
        """
        INSERT INTO device (device_sn, device_pn, type, alias, roles)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (device_sn) DO UPDATE
            SET device_pn = EXCLUDED.device_pn,
                type      = EXCLUDED.type,
                alias     = EXCLUDED.alias,
                roles     = COALESCE(device.roles, EXCLUDED.roles)
        """,
        snapshot.get("device_sn"),
        snapshot.get("device_pn"),
        device_type,
        snapshot.get("alias") or snapshot.get("device_pn"),
        _ROLES_BY_TYPE.get(device_type or ""),
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

# Numeric fields of a wallbox snapshot (in INSERT column order), and the same
# list without energy_wh for a DB whose backend has not added that column yet.
_WALLBOX_FIELDS_LEGACY = (
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
_WALLBOX_FIELDS = (*_WALLBOX_FIELDS_LEGACY, "energy_wh")


# Whether wallbox_reading.energy_wh exists, probed once per process.
# The column is created by a BACKEND migration, and the two are deployed
# independently (scripts/deploy.sh app / collector), so the collector cannot
# assume it is there: writing to a missing column would fail every insert and
# turn a routine deploy-order difference into a total loss of wallbox data.
# Falling back drops only the energy integration, which the backend backfills
# from the recorded timestamps once its own migration runs.
_energy_wh_supported: bool | None = None


async def _has_energy_wh(pool: asyncpg.Pool) -> bool:
    global _energy_wh_supported
    if _energy_wh_supported is None:
        _energy_wh_supported = await pool.fetchval(
            """
            SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_name = 'wallbox_reading' AND column_name = 'energy_wh'
            )
            """
        )
        if not _energy_wh_supported:
            LOG.warning(
                "wallbox_reading.energy_wh missing - deploy the backend to add it; "
                "recording readings without per-sample energy until then"
            )
    return _energy_wh_supported


async def insert_wallbox_reading(pool: asyncpg.Pool, snapshot: dict) -> None:
    """Store a wallbox snapshot as a measurement row."""
    fields = _WALLBOX_FIELDS if await _has_energy_wh(pool) else _WALLBOX_FIELDS_LEGACY
    columns = ", ".join(fields)
    placeholders = ", ".join(f"${i}" for i in range(2, len(fields) + 2))
    await pool.execute(
        f"""
        INSERT INTO wallbox_reading (device_sn, {columns})
        VALUES ($1, {placeholders})
        """,
        snapshot.get("device_sn"),
        *[snapshot.get(f) for f in fields],
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


async def read_device_configs(pool: asyncpg.Pool, drivers: list[str]) -> list[dict] | None:
    """Return the enabled `device_config` rows for these drivers, lowest id first.

    Returns None (not []) when the table is missing, so the caller can tell
    "backend has not migrated yet" from "nothing is enabled" - the two look the
    same to a supervisor but only one of them is worth warning about. The
    collector and backend deploy independently (scripts/deploy.sh app vs
    collector), so the table genuinely can be absent for a while.
    """
    try:
        rows = await pool.fetch(
            "SELECT id, driver, name, enabled, host, port, unit_id, "
            "       poll_interval_s, device_sn "
            "  FROM device_config "
            " WHERE enabled AND driver = ANY($1::TEXT[]) "
            " ORDER BY id",
            drivers,
        )
    except asyncpg.UndefinedTableError:
        return None
    return [dict(r) for r in rows]


async def bind_device_sn(pool: asyncpg.Pool, config_id: int, device_sn: str) -> None:
    """Bind a config row to the serial the collector just saw on it.

    This is where the two tables meet: `device_config` is what the user
    configured, `device` is what was actually found at that address. Binding
    only happens when the row is still unbound - a row already pointing at a
    serial keeps it, so replacing the hardware behind an address is a
    deliberate act (clear the binding) rather than a silent rebind that would
    move the row's identity out from under the history.

    A serial can only be bound once (partial unique index), so two config rows
    aimed at the same physical device lose the race for the second one. That is
    a misconfiguration, not a crash: log it and carry on collecting.
    """
    try:
        await pool.execute(
            "UPDATE device_config SET device_sn = $2, updated_at = now() "
            " WHERE id = $1 AND device_sn IS NULL",
            config_id,
            device_sn,
        )
    except asyncpg.UniqueViolationError:
        LOG.warning(
            "device_config #%s: serial %s is already bound to another config row "
            "- two rows are pointing at the same device",
            config_id, device_sn,
        )
    except asyncpg.UndefinedTableError:
        pass  # backend has not migrated yet; nothing to bind to


async def last_sma_reading(pool: asyncpg.Pool, device_sn: str) -> dict | None:
    """Most recent reading OF ONE INVERTER (for seeding the daily_yield carry
    after a restart and for writing asleep rows when it is unreachable).

    grid_power seeds the "was it producing?" check that decides whether an
    unreachable inverter may be recorded as 0 W (sma_stream.sleep_implausible).

    `device_sn` is required rather than optional-with-a-global-fallback: the
    carried serial is what an unreachable inverter's rows are written under, so
    "whichever inverter wrote last" is not a harmless default once a second one
    is configured - it is one instance writing readings for another. Callers
    that do not know which device they mean must not seed at all.
    """
    try:
        row = await pool.fetchrow(
            "SELECT r.time, r.device_sn, d.device_pn, r.grid_power, "
            "       r.daily_yield_wh, r.total_yield_kwh "
            "FROM sma_readings r "
            "LEFT JOIN device d ON d.device_sn = r.device_sn "
            "WHERE r.device_sn = $1 "
            "ORDER BY r.time DESC LIMIT 1",
            device_sn,
        )
    except asyncpg.UndefinedTableError:
        return None
    return dict(row) if row else None


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
