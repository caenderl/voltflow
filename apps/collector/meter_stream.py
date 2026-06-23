"""
meter_stream.py - Wiederverwendbare MQTT-Anbindung an den Anker Solix Smart Meter.

Stellt `stream_readings()` bereit: einen async-Generator, der alle paar Sekunden
einen Snapshot der Live-Werte liefert. Wird sowohl von der CLI (poke_meter.py)
als auch vom Collector (collector.py) genutzt.

Geliefert werden die fuer Ueberschussladen relevanten Felder:
  - grid_to_home_power  : Netzbezug in W (Import)
  - pv_to_grid_power    : Einspeisung in W (Ueberschuss)
  - grid_import_energy  : Zaehlerstand Bezug in kWh
  - grid_export_energy  : Zaehlerstand Einspeisung in kWh
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

# Felder, die wir aus dem MQTT-Status rauspicken (fuer Snapshot + DB)
METER_KEYS = [
    "device_sn",
    "grid_to_home_power",
    "pv_to_grid_power",
    "grid_import_energy",
    "grid_export_energy",
    "msg_timestamp",
]


def creds() -> tuple[str, str, str]:
    """ANKER-Zugangsdaten aus der Umgebung lesen (.env wird vom Aufrufer geladen)."""
    user = os.getenv("ANKERUSER")
    pw = os.getenv("ANKERPASSWORD")
    country = os.getenv("ANKERCOUNTRY", "DE")
    if not user or not pw:
        sys.exit("ANKERUSER / ANKERPASSWORD nicht gesetzt (env oder .env).")
    return user, pw, country


def find_smartmeter(devices: dict) -> tuple[str | None, dict | None]:
    """Erstes Smart-Meter-Geraet (sn, device-dict) aus dem Device-Cache ziehen."""
    for sn, dev in devices.items():
        if dev.get("type") == "smartmeter" or str(dev.get("device_pn", "")).startswith("A17X7"):
            return sn, dev
    return None, None


def meter_snapshot(status: dict) -> dict:
    """Relevante Felder aus dem MQTT-Status rauspicken."""
    return {k: status.get(k) for k in METER_KEYS if k in status}


async def stream_readings(
    interval: int = 5,
) -> AsyncIterator[dict]:
    """Async-Generator, der Smart-Meter-Snapshots liefert.

    Es wird in jedem Intervall ein Snapshot geliefert (der Realtime-Trigger
    haelt die Werte ~5s-aktuell). Auf msg_timestamp zu deduplizieren funktioniert
    beim A17X7 nicht - das Feld aendert sich nicht pro Nachricht.

    Args:
        interval: Sekunden zwischen den Abfragen des MQTT-Status-Caches.

    Yields:
        dict mit den METER_KEYS-Feldern (Werte als Strings, wie von der API).
    """
    user, pw, country = creds()

    async with ClientSession() as session:
        myapi = AnkerSolixApi(user, pw, country, session, LOG)

        # Geraete-Cache fuellen, um den Smart Meter zu finden
        await myapi.update_sites()
        await myapi.update_device_details()

        sn, dev = find_smartmeter(myapi.devices)
        if not sn:
            raise RuntimeError("Kein Smart Meter im Device-Cache gefunden.")
        LOG.info("Smart Meter gefunden: %s (%s)", dev.get("alias") or dev.get("name"), sn)

        mdev = SolixMqttDeviceFactory(myapi, sn).create_device()
        mqtt_session = await myapi.startMqttSession()
        if not (mqtt_session and mqtt_session.is_connected()):
            raise RuntimeError("MQTT-Verbindung fehlgeschlagen.")
        LOG.info("MQTT verbunden: %s:%s", mqtt_session.host, mqtt_session.port)

        # Geraete-Topics (Daten + Kommandos) abonnieren
        topics: set[str] = set()
        if prefix := mqtt_session.get_topic_prefix(deviceDict=dev):
            topics.add(f"{prefix}#")
        if cmd_prefix := mqtt_session.get_topic_prefix(deviceDict=dev, publish=True):
            topics.add(f"{cmd_prefix}#")

        # Background-Poller: abonniert, sendet Realtime-Trigger (~5s) und haelt ihn
        # am Leben. msg_callback=None -> Standard-Callback fuellt den Geraete-Cache.
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
