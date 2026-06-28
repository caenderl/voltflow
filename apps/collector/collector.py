"""
collector.py - Reads the smart meter values via MQTT and writes them to the DB.

Start (locally, in the root venv):
    python apps/collector/collector.py

Configuration via .env / env:
    ANKERUSER, ANKERPASSWORD, ANKERCOUNTRY
    DATABASE_URL=postgresql://voltflow:voltflow@localhost:5432/voltflow
"""

import asyncio
import logging
import os
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

__version__ = (Path(__file__).parent / "VERSION").read_text().strip()

from db import (
    create_pool,
    insert_reading,
    insert_sma_reading,
    insert_wallbox_reading,
    last_sma_reading,
    read_sma_config,
    read_wallbox_config,
    register_device,
    register_sma,
    register_wallbox,
)
from meter_stream import stream_readings
from sma_stream import stream_sma
from wallbox_stream import stream_wallbox

# Local timezone for the daily_yield day boundary (matches the DB day buckets).
_TZ = ZoneInfo("Europe/Berlin")
# Power fields zeroed in an asleep row written when the inverter is unreachable.
_SMA_POWER_FIELDS = ("grid_power", "pv_power_a", "pv_power_b", "power_l1", "power_l2", "power_l3")

load_dotenv()

logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
LOG = logging.getLogger("voltflow.collector")
LOG.setLevel(logging.INFO)
LOG.info("Voltflow collector %s starting", __version__)

# Seconds before reconnecting if the MQTT stream breaks
RECONNECT_DELAY = 10


async def _create_pool_with_retry():
    """Build the pool; retry if the DB is not (yet) reachable."""
    while True:
        try:
            return await create_pool()
        except Exception as err:  # noqa: BLE001
            LOG.warning("DB not reachable (%s) - retrying in %ss",
                        type(err).__name__, RECONNECT_DELAY)
            await asyncio.sleep(RECONNECT_DELAY)


async def _run_meter(pool) -> None:
    """Continuously stream smart meter readings into the DB (with reconnect)."""
    device_registered = False
    count = 0
    while True:
        try:
            async for reading in stream_readings(interval=5):
                if not device_registered:
                    await register_device(pool, reading)
                    device_registered = True
                await insert_reading(pool, reading)
                count += 1
                if count % 12 == 0:  # ~one status line per minute
                    LOG.info(
                        "%d meter readings stored (latest: g2h=%s pv2g=%s)",
                        count,
                        reading.get("grid_to_home_power"),
                        reading.get("pv_to_grid_power"),
                    )
        except Exception as err:  # noqa: BLE001
            LOG.warning("Meter stream error: %s: %s - reconnecting in %ss",
                        type(err).__name__, err, RECONNECT_DELAY)
            await asyncio.sleep(RECONNECT_DELAY)


async def _run_wallbox(pool, cfg: dict) -> None:
    """Continuously poll the wallbox via Modbus into the DB (with reconnect)."""
    host = cfg["host"]
    port = cfg.get("port") or 502
    unit_id = cfg.get("unit_id") or 1
    interval = cfg.get("poll_interval_s") or 30
    device_registered = False
    count = 0
    while True:
        try:
            async for snap in stream_wallbox(host, port=port, unit_id=unit_id, interval=interval):
                if not device_registered:
                    await register_wallbox(pool, snap)
                    device_registered = True
                await insert_wallbox_reading(pool, snap)
                count += 1
                LOG.info(
                    "wallbox reading #%d stored (status=%s power=%sW)",
                    count, snap.get("status"), snap.get("active_power_w"),
                )
        except Exception as err:  # noqa: BLE001
            LOG.warning("Wallbox stream error: %s: %s - reconnecting in %ss",
                        type(err).__name__, err, RECONNECT_DELAY)
            await asyncio.sleep(RECONNECT_DELAY)


async def _run_sma(pool, cfg: dict, password: str) -> None:
    """Continuously poll the SMA inverter into the DB.

    Night-safe: a sleeping/unreachable inverter is written as an `asleep` row
    (0 W) with the daily_yield carried over within the same local day, instead
    of crashing or spamming the log. Logs only on wake<->sleep transitions.
    """
    host = cfg["host"]
    interval = cfg.get("poll_interval_s") or 60

    # Carry state (seeded from the DB so a night restart keeps today's yield).
    carry = {"date": None, "daily_wh": None, "total_kwh": None,
             "serial": None, "model": None}
    try:
        seed = await last_sma_reading(pool)
    except Exception as err:  # noqa: BLE001 - seed must never crash the collector
        LOG.warning("SMA seed read failed (%s: %s) - continuing without carry",
                    type(err).__name__, err)
        seed = None
    if seed:
        carry["serial"] = seed.get("device_sn")
        carry["model"] = seed.get("device_pn")
        if seed.get("total_yield_kwh") is not None:
            carry["total_kwh"] = float(seed["total_yield_kwh"])
        if seed.get("time") is not None and seed.get("daily_yield_wh") is not None:
            carry["date"] = seed["time"].astimezone(_TZ).date()
            carry["daily_wh"] = float(seed["daily_yield_wh"])

    registered = False
    awake = None  # None = unknown; for wake/sleep transition logging

    def apply_carry(snap: dict) -> None:
        today = datetime.now(_TZ).date()
        if snap.get("daily_yield_wh") is not None:
            carry["date"], carry["daily_wh"] = today, float(snap["daily_yield_wh"])
        else:
            # Carry only within the same local day; a new day starts at 0.
            snap["daily_yield_wh"] = carry["daily_wh"] if carry["date"] == today else 0.0
        if snap.get("total_yield_kwh") is not None:
            carry["total_kwh"] = float(snap["total_yield_kwh"])
        elif carry["total_kwh"] is not None:
            snap["total_yield_kwh"] = carry["total_kwh"]

    def log_transition(snap: dict) -> None:
        nonlocal awake
        now_awake = not snap.get("asleep")
        if awake is None or now_awake != awake:
            if now_awake:
                LOG.info("SMA awake: grid_power=%sW daily_yield=%sWh",
                         snap.get("grid_power"), snap.get("daily_yield_wh"))
            else:
                LOG.info("SMA asleep: 0 W, daily_yield carried=%sWh",
                         snap.get("daily_yield_wh"))
            awake = now_awake

    while True:
        try:
            async for snap in stream_sma(host, password, interval=interval):
                carry["serial"] = snap.get("device_sn") or carry["serial"]
                carry["model"] = snap.get("device_pn") or carry["model"]
                apply_carry(snap)
                if not registered:
                    await register_sma(pool, snap)
                    registered = True
                await insert_sma_reading(pool, snap)
                log_transition(snap)
        except Exception as err:  # noqa: BLE001
            # Session could not be (re)established -> usually night/unreachable.
            # Persist an asleep row (carried yield) if we know the device; retry
            # at the poll interval and log only on the wake->sleep transition.
            if carry["serial"]:
                snap = {f: 0.0 for f in _SMA_POWER_FIELDS}
                snap.update(asleep=True, device_sn=carry["serial"], device_pn=carry["model"])
                apply_carry(snap)
                try:
                    await insert_sma_reading(pool, snap)
                except Exception:  # noqa: BLE001
                    pass
                log_transition(snap)
            elif awake is not False:
                LOG.info("SMA not reachable yet (%s: %s) - retrying every %ss",
                         type(err).__name__, err, interval)
                awake = False
            await asyncio.sleep(interval)


async def run() -> None:
    pool = await _create_pool_with_retry()
    try:
        tasks = [asyncio.create_task(_run_meter(pool))]

        cfg = await read_wallbox_config(pool)
        if cfg and cfg.get("enabled") and cfg.get("host"):
            LOG.info("Wallbox configured (%s:%s) - starting wallbox collector",
                     cfg["host"], cfg.get("port") or 502)
            tasks.append(asyncio.create_task(_run_wallbox(pool, cfg)))
        else:
            LOG.info("No wallbox configured - skipping wallbox collector "
                     "(restart after enabling it in the settings)")

        sma_cfg = await read_sma_config(pool)
        sma_password = os.getenv("SMA_PASSWORD")
        if sma_cfg and sma_cfg.get("enabled") and sma_cfg.get("host"):
            if not sma_password:
                LOG.warning("SMA configured but SMA_PASSWORD not set - skipping SMA collector")
            else:
                LOG.info("SMA configured (%s) - starting SMA collector", sma_cfg["host"])
                tasks.append(asyncio.create_task(_run_sma(pool, sma_cfg, sma_password)))
        else:
            LOG.info("No SMA inverter configured - skipping SMA collector "
                     "(restart after enabling it in the settings)")

        await asyncio.gather(*tasks)
    finally:
        await pool.close()


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
