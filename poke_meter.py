"""
poke_meter.py - Live-Werte vom Anker Solix Smart Meter (A17X7) auslesen.

Wichtig: Der Smart Meter laeuft hier "standalone" (keine Power-System-Site).
Die Cloud-Api liefert fuer Standalone-Geraete KEINE Leistungswerte - die kommen
nur ueber den MQTT-Cloud-Server. Drum holen wir die Werte per MQTT:
  - grid_to_home_power  : Netzbezug in W (Import)
  - pv_to_grid_power    : Einspeisung in W (Ueberschuss)
  - grid_import_energy  : Zaehlerstand Bezug in kWh
  - grid_export_energy  : Zaehlerstand Einspeisung in kWh

Setup vorher:
    python3 -m venv venv && . venv/bin/activate
    pip install cryptography aiohttp aiofiles paho-mqtt python-dotenv
    git clone https://github.com/thomluther/anker-solix-api.git
    cd anker-solix-api && pip install --editable .

Credentials per .env oder env-Variablen:
    ANKERUSER="deine@mail.de"
    ANKERPASSWORD="..."          # Sonderzeichen -> in Anfuehrungszeichen!
    ANKERCOUNTRY="DE"

Start:
    python poke_meter.py            # einmalig eine Messung holen und ausgeben
    python poke_meter.py --loop     # alle 5s die Meter-Werte pollen
    python poke_meter.py --raw      # kompletten MQTT-Status-Dump zeigen
"""

import asyncio
import json
import logging
import os
import sys

from aiohttp import ClientSession
from anker_solix_api.api import AnkerSolixApi
from anker_solix_api.mqtt_factory import SolixMqttDeviceFactory
from dotenv import load_dotenv

load_dotenv()  # liest .env (falls vorhanden) in die Umgebung

logging.basicConfig(level=logging.WARNING)
LOG = logging.getLogger("poke")
LOG.setLevel(logging.INFO)

# Smart-Meter Produktnummern, die wir unterstuetzen (A17X7 = Anker 3-Phasen WiFi)
SMARTMETER_PNS = ("A17X7", "A17X7US")

# Felder, die fuer Ueberschussladen interessant sind (aus dem MQTT-Status)
METER_KEYS = [
    "device_sn",
    "grid_to_home_power",
    "pv_to_grid_power",
    "grid_import_energy",
    "grid_export_energy",
    "msg_timestamp",
]


def creds():
    user = os.getenv("ANKERUSER")
    pw = os.getenv("ANKERPASSWORD")
    country = os.getenv("ANKERCOUNTRY", "DE")
    if not user or not pw:
        sys.exit("ANKERUSER / ANKERPASSWORD nicht gesetzt (env oder .env).")
    return user, pw, country


def find_smartmeter(devices: dict):
    """Erstes Smart-Meter-Geraet aus dem Device-Cache (sn, device-dict) ziehen."""
    for sn, dev in devices.items():
        if dev.get("type") == "smartmeter" or str(dev.get("device_pn", "")).startswith("A17X7"):
            return sn, dev
    return None, None


def meter_snapshot(status: dict) -> dict:
    """Die relevanten Felder aus dem MQTT-Status rauspicken."""
    return {k: status.get(k) for k in METER_KEYS if k in status}


async def run(loop_mode: bool, raw: bool, interval: int = 5):
    user, pw, country = creds()

    async with ClientSession() as session:
        myapi = AnkerSolixApi(user, pw, country, session, LOG)

        # Geraete-Cache fuellen, um den Smart Meter zu finden
        await myapi.update_sites()
        await myapi.update_device_details()

        sn, dev = find_smartmeter(myapi.devices)
        if not sn:
            LOG.warning("Kein Smart Meter im Cache gefunden. Voller Device-Dump folgt:")
            print(json.dumps(myapi.devices, indent=2, ensure_ascii=False))
            return

        LOG.info(f"Smart Meter gefunden: {dev.get('alias') or dev.get('name')} ({sn})")

        # MQTT-Geraet + Session aufbauen
        mdev = SolixMqttDeviceFactory(myapi, sn).create_device()
        mqtt_session = await myapi.startMqttSession()
        if not (mqtt_session and mqtt_session.is_connected()):
            sys.exit("MQTT-Verbindung fehlgeschlagen.")
        LOG.info(f"MQTT verbunden: {mqtt_session.host}:{mqtt_session.port}")

        # Topics des Geraets (Daten + Kommandos) abonnieren
        topics = set()
        if prefix := mqtt_session.get_topic_prefix(deviceDict=dev):
            topics.add(f"{prefix}#")
        if cmd_prefix := mqtt_session.get_topic_prefix(deviceDict=dev, publish=True):
            topics.add(f"{cmd_prefix}#")

        # Background-Poller: abonniert Topics, sendet Realtime-Trigger (~5s-Takt)
        # und haelt ihn am Leben. msg_callback=None -> Standard-Callback fuellt den
        # Geraete-Cache, sodass mdev.get_status() die Werte liefert.
        poller = asyncio.get_running_loop().create_task(
            mqtt_session.message_poller(
                topics=topics,
                trigger_devices={sn},
                msg_callback=None,
                timeout=60,
            )
        )

        try:
            # kurz warten, bis die ersten Realtime-Messages da sind
            for _ in range(12):
                await asyncio.sleep(1)
                if mdev.get_status().get("grid_to_home_power") is not None:
                    break

            def show():
                status = mdev.get_status()
                if raw:
                    print(json.dumps(status, indent=2, ensure_ascii=False))
                else:
                    print(json.dumps(meter_snapshot(status), indent=2, ensure_ascii=False))

            if not loop_mode:
                show()
                return

            LOG.info(f"Polling-Loop alle {interval}s (Strg-C zum Beenden) ...")
            while True:
                show()
                print("-" * 50)
                await asyncio.sleep(interval)
        finally:
            poller.cancel()
            myapi.stopMqttSession()


async def main():
    loop_mode = "--loop" in sys.argv
    raw = "--raw" in sys.argv
    await run(loop_mode, raw)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
