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
from pathlib import Path

from dotenv import load_dotenv

__version__ = (Path(__file__).parent / "VERSION").read_text().strip()

from db import (
    create_pool,
    insert_reading,
    insert_wallbox_reading,
    read_wallbox_config,
    register_device,
    register_wallbox,
)
from meter_stream import stream_readings
from wallbox_stream import stream_wallbox

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

        await asyncio.gather(*tasks)
    finally:
        await pool.close()


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
