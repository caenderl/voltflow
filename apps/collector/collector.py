"""
collector.py - Reads the smart meter values via MQTT and writes them to the DB.

Start (locally, in the root venv):
    python apps/collector/collector.py

Configuration via .env / env:
    ANKERUSER, ANKERPASSWORD, ANKERCOUNTRY
    DATABASE_URL=postgresql://poke:poke@localhost:5432/poke
"""

import asyncio
import logging

from dotenv import load_dotenv

from db import create_pool, insert_reading, register_device
from meter_stream import stream_readings

load_dotenv()

logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
LOG = logging.getLogger("poke.collector")
LOG.setLevel(logging.INFO)

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


async def run() -> None:
    pool = await _create_pool_with_retry()
    device_registered = False
    count = 0
    try:
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
                            "%d readings stored (latest: g2h=%s pv2g=%s)",
                            count,
                            reading.get("grid_to_home_power"),
                            reading.get("pv_to_grid_power"),
                        )
            except Exception as err:  # noqa: BLE001
                LOG.warning("Stream error: %s: %s - reconnecting in %ss",
                            type(err).__name__, err, RECONNECT_DELAY)
                await asyncio.sleep(RECONNECT_DELAY)
    finally:
        await pool.close()


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
