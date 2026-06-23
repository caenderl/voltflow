# poke-meter

Erfasst die Live-Werte des **Anker Solix Smart Meters (A17X7)** über den MQTT-Cloud-Server,
speichert sie in **TimescaleDB** und stellt sie in einer Web-App grafisch dar
(Live, Tag, Woche, Monat). Vorbereitet für spätere Wallbox-Anbindung.

## Architektur

```
Anker Cloud MQTT ──(5s)──▶ Collector (Python)
                              │ INSERT + NOTIFY
                              ▼
                          TimescaleDB  ──▶ Backend (NestJS, REST + WebSocket)
                                              ▼
   Browser ◀── nginx (Angular + Proxy) ◀── Frontend (Angular + ngx-echarts)
```

NX-Monorepo:

| Pfad | Inhalt |
|------|--------|
| `apps/collector` | Python-Ingestion (nutzt `anker-solix-api` via MQTT) |
| `apps/backend`   | NestJS: REST (`/api/meter/...`) + WebSocket (Live) |
| `apps/frontend`  | Angular-Dashboard (ngx-echarts) |
| `libs/shared-types` | Geteilte TypeScript-Typen Backend ↔ Frontend |
| `db/init.sql`    | Hypertable, Continuous Aggregates, NOTIFY-Trigger |

> Hinweis: Der Smart Meter läuft **standalone** (kein Power-System). Verfügbar sind nur
> Netzbezug (`grid_to_home_power`), Einspeisung/Überschuss (`pv_to_grid_power`) und die
> kumulativen Zählerstände — **keine** vollständige PV-Produktion/Hauslast.

## Konfiguration

`.env` im Repo-Root (siehe `.env.example`):

```
ANKERUSER="deine@mail.de"
ANKERPASSWORD="..."          # Sonderzeichen -> in Anfuehrungszeichen!
ANKERCOUNTRY="DE"
DATABASE_URL="postgresql://poke:poke@localhost:5432/poke"
```

## Entwicklung (lokal)

DB im Container, der Rest lokal:

```bash
# 1. TimescaleDB starten
docker compose up -d db

# 2. Python-venv + Abhängigkeiten (einmalig)
python3 -m venv venv && . venv/bin/activate
pip install cryptography aiohttp aiofiles paho-mqtt python-dotenv asyncpg
git clone https://github.com/thomluther/anker-solix-api.git
cd anker-solix-api && pip install --editable . && cd ..

# 3. Node-Abhängigkeiten (einmalig)
npm ci

# 4. Collector starten (schreibt Messwerte in die DB)
. venv/bin/activate && python apps/collector/collector.py

# 5. Backend
npx nx serve backend         # http://localhost:3000/api

# 6. Frontend
npx nx serve frontend        # http://localhost:4200  (Proxy /api + /socket.io -> :3000)
```

## Deployment (Raspberry Pi 5, arm64)

Alles als Container. Images werden nativ für arm64 gebaut (auf dem Pi selbst oder
auf einem Apple-Silicon-Mac; sonst `docker buildx --platform linux/arm64`).

```bash
# .env mit Credentials muss vorhanden sein
docker compose -f docker-compose.prod.yml up -d --build
# -> Dashboard: http://<pi>:8080
```

Services: `db` (TimescaleDB), `collector`, `backend`, `frontend` (nginx, Port 8080,
reverse-proxyt `/api` + `/socket.io` ans Backend). DB-Daten liegen im Volume `poke-db-data`.

## API

| Endpoint | Beschreibung |
|----------|--------------|
| `GET /api/meter/latest` | Letzter Messwert |
| `GET /api/meter/series?from&to&resolution=raw\|1min\|1hour\|1day` | Leistungs-Zeitreihe |
| `GET /api/meter/energy?period=day\|week\|month&date=YYYY-MM-DD` | kWh-Bezug/Einspeisung |
| WS-Event `reading` | Live-Messwert (~alle 5 s) |

## Roadmap

- Wallbox auslesen & steuern (eigenes Backend-Modul + Collector-Erweiterung)
- Auth (aktuell für lokales Heimnetz ausgelegt)
