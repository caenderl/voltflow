"""
meter_stream.py - Reusable MQTT connection to the Anker Solix Smart Meter.

Provides `stream_readings()`: an async generator that yields a snapshot of the
live values every few seconds. Used by the collector (collector.py).

Yields the fields relevant for surplus charging:
  - grid_to_home_power  : grid import in W
  - pv_to_grid_power    : feed-in / surplus in W
  - grid_import_energy  : cumulative import meter reading in kWh
  - grid_export_energy  : cumulative export meter reading in kWh
"""

import asyncio
import logging
import os
import sys
from collections.abc import AsyncIterator

from aiohttp import ClientSession
from anker_solix_api.api import AnkerSolixApi
from anker_solix_api.mqtt_factory import SolixMqttDeviceFactory

LOG = logging.getLogger("poke.stream")

# Fields we pick from the MQTT status (for snapshot + DB)
METER_KEYS = [
    "device_sn",
    "grid_to_home_power",
    "pv_to_grid_power",
    "grid_import_energy",
    "grid_export_energy",
    "msg_timestamp",
]


def creds() -> tuple[str, str, str]:
    """Read ANKER credentials from the environment (.env is loaded by the caller)."""
    user = os.getenv("ANKERUSER")
    pw = os.getenv("ANKERPASSWORD")
    country = os.getenv("ANKERCOUNTRY", "DE")
    if not user or not pw:
        sys.exit("ANKERUSER / ANKERPASSWORD not set (env or .env).")
    return user, pw, country


def find_smartmeter(devices: dict) -> tuple[str | None, dict | None]:
    """Return the first smart meter device (sn, device dict) from the device cache."""
    for sn, dev in devices.items():
        if dev.get("type") == "smartmeter" or str(dev.get("device_pn", "")).startswith("A17X7"):
            return sn, dev
    return None, None


def meter_snapshot(status: dict) -> dict:
    """Pick the relevant fields from the MQTT status."""
    return {k: status.get(k) for k in METER_KEYS if k in status}


async def stream_readings(
    interval: int = 5,
) -> AsyncIterator[dict]:
    """Async generator yielding smart meter snapshots.

    Yields a snapshot on every interval (the realtime trigger keeps the values
    fresh to ~5s). Deduplicating on msg_timestamp does not work on the A17X7 -
    that field does not change per message.

    Args:
        interval: seconds between polls of the MQTT status cache.

    Yields:
        dict with the METER_KEYS fields (values as strings, as from the API).
    """
    user, pw, country = creds()

    async with ClientSession() as session:
        myapi = AnkerSolixApi(user, pw, country, session, LOG)

        # Populate the device cache to locate the smart meter
        await myapi.update_sites()
        await myapi.update_device_details()

        sn, dev = find_smartmeter(myapi.devices)
        if not sn:
            raise RuntimeError("No smart meter found in the device cache.")
        LOG.info("Smart meter found: %s (%s)", dev.get("alias") or dev.get("name"), sn)

        mdev = SolixMqttDeviceFactory(myapi, sn).create_device()
        mqtt_session = await myapi.startMqttSession()
        if not (mqtt_session and mqtt_session.is_connected()):
            raise RuntimeError("MQTT connection failed.")
        LOG.info("MQTT connected: %s:%s", mqtt_session.host, mqtt_session.port)

        # Subscribe to the device topics (data + commands)
        topics: set[str] = set()
        if prefix := mqtt_session.get_topic_prefix(deviceDict=dev):
            topics.add(f"{prefix}#")
        if cmd_prefix := mqtt_session.get_topic_prefix(deviceDict=dev, publish=True):
            topics.add(f"{cmd_prefix}#")

        # Background poller: subscribes, sends the realtime trigger (~5s) and keeps
        # it alive. msg_callback=None -> default callback fills the device cache.
        poller = asyncio.get_running_loop().create_task(
            mqtt_session.message_poller(
                topics=topics,
                trigger_devices={sn},
                msg_callback=None,
                timeout=60,
            )
        )

        try:
            while True:
                status = mdev.get_status()
                if status.get("grid_to_home_power") is not None:
                    snap = meter_snapshot(status)
                    snap.setdefault("device_sn", sn)
                    yield snap
                await asyncio.sleep(interval)
        finally:
            poller.cancel()
            myapi.stopMqttSession()
