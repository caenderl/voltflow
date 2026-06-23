"""
poke_meter.py - CLI: Live-Werte vom Anker Solix Smart Meter (A17X7) anzeigen.

Die eigentliche MQTT-Anbindung steckt in apps/collector/meter_stream.py
(wird auch vom Collector genutzt). Dieses Skript ist nur die Konsolen-Ansicht.

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
    python poke_meter.py --loop     # fortlaufend die Meter-Werte zeigen
"""

import asyncio
import json
import logging
import os
import sys

from dotenv import load_dotenv

# meter_stream liegt in apps/collector
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "apps", "collector"))
from meter_stream import stream_readings  # noqa: E402

load_dotenv()

logging.basicConfig(level=logging.WARNING)
LOG = logging.getLogger("poke")
LOG.setLevel(logging.INFO)


async def main():
    loop_mode = "--loop" in sys.argv

    async for reading in stream_readings(interval=5):
        print(json.dumps(reading, indent=2, ensure_ascii=False))
        if not loop_mode:
            return
        print("-" * 50)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
