"""
sma_stream.py - Reusable Speedwire connection to an SMA PV inverter
(STP 6000TL-20) via pysma-plus.

Provides `stream_sma()`: an async generator that yields a snapshot of the live
values every `interval` seconds. Used by the collector (collector.py).

Lifecycle: one persistent aiohttp.ClientSession + device session (new_session /
close_session) is held for the whole stream, NOT rebuilt per poll.

Night behaviour: after sunset the inverter sleeps. A read timeout / empty read
during an established session is the NORMAL night state -> an `asleep` snapshot
(0 W) is yielded instead of raising, so the caller does not reconnect-spam.
Only a failure to establish the session at all raises (caller reconnects).
The daily_yield carry-over is handled by the caller (collector._run_sma).
"""

import asyncio
import logging
from collections.abc import AsyncIterator

from aiohttp import ClientSession
import pysmaplus as smaplus

LOG = logging.getLogger("voltflow.sma")

# pysma-plus sensor .name -> snapshot field (units already match the DB columns)
_FIELD_MAP = {
    "grid_power": "grid_power",
    "pv_power_a": "pv_power_a",
    "pv_power_b": "pv_power_b",
    "daily_yield": "daily_yield_wh",     # Wh
    "total_yield": "total_yield_kwh",    # kWh
    "power_l1": "power_l1",
    "power_l2": "power_l2",
    "power_l3": "power_l3",
    "pv_voltage_a": "pv_voltage_a",
    "pv_voltage_b": "pv_voltage_b",
    "pv_current_a": "pv_current_a",
    "pv_current_b": "pv_current_b",
    "voltage_l1": "voltage_l1",
    "voltage_l2": "voltage_l2",
    "voltage_l3": "voltage_l3",
    "frequency": "frequency",
    "temp_a": "temp_a",
    "status": "status",
}

# Power fields zeroed out in an asleep snapshot.
_POWER_FIELDS = (
    "grid_power", "pv_power_a", "pv_power_b", "power_l1", "power_l2", "power_l3",
)

# Checked to decide "no production reading at all". Must be ALL of these, not
# just grid_power - a single dropped Speedwire UDP read can leave grid_power
# missing on an otherwise-normal read where pv_power_a/b came through fine,
# which is a lossy read, not the inverter actually asleep.
_PRODUCTION_FIELDS = ("grid_power", "pv_power_a", "pv_power_b")


def _num(value) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _asleep_snapshot() -> dict:
    """Inverter is sleeping: power fields 0, energy/diagnostics left to carry."""
    snap: dict = {f: 0.0 for f in _POWER_FIELDS}
    snap["asleep"] = True
    # daily_yield_wh / total_yield_kwh stay absent -> carried by the caller.
    return snap


async def _read_snapshot(device, sensors) -> dict:
    """One read cycle. Returns a values dict; asleep snapshot on timeout/empty."""
    try:
        ok = await device.read(sensors)
    except (asyncio.TimeoutError, OSError):
        return _asleep_snapshot()
    if not ok:
        return _asleep_snapshot()

    values: dict = {}
    for s in sensors:
        field = _FIELD_MAP.get(s.name)
        if field is not None:
            values[field] = _num(s.value)

    # No production reading at all -> treat as asleep.
    if all(values.get(f) is None for f in _PRODUCTION_FIELDS):
        snap = _asleep_snapshot()
        # keep any energy counters we did get (e.g. total_yield)
        for k in ("daily_yield_wh", "total_yield_kwh"):
            if values.get(k) is not None:
                snap[k] = values[k]
        return snap

    values["asleep"] = False
    # status comes through as float -> int for the SMALLINT/INT column
    if values.get("status") is not None:
        values["status"] = int(values["status"])
    return values


async def stream_sma(
    host: str,
    password: str,
    interval: int = 60,
) -> AsyncIterator[dict]:
    """Async generator yielding SMA snapshots every `interval` seconds.

    Raises on failure to establish the session (caller reconnects). Read
    timeouts during an established session yield an asleep snapshot instead.

    Yields:
        dict with device_sn, device_pn and the live measurement fields.
    """
    session = ClientSession()
    device = None
    try:
        device = smaplus.getDevice(
            session, host, password=password, groupuser="user", accessmethod="speedwireinv"
        )
        if device is None:
            raise RuntimeError(f"SMA getDevice returned None for {host}")
        if not await device.new_session():
            raise RuntimeError(f"SMA session/auth failed for {host}")

        info = await device.device_info()
        serial = str(info.get("serial") or info.get("id") or "")
        model = info.get("name")
        if not serial:
            raise RuntimeError("SMA returned empty serial number")
        LOG.info("SMA connected: %s (%s) at %s", model, serial, host)

        sensors = await device.get_sensors()
        while True:
            snap = await _read_snapshot(device, sensors)
            snap["device_sn"] = serial
            snap["device_pn"] = model
            yield snap
            await asyncio.sleep(interval)
    finally:
        if device is not None:
            try:
                await device.close_session()
            except Exception:  # noqa: BLE001
                pass
        await session.close()
