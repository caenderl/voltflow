# Voltflow

Erfasst die Live-Werte des **Anker Solix Smart Meters (A17X7)** über den MQTT-Cloud-Server,
speichert sie in **TimescaleDB** und stellt sie in einer Web-App grafisch dar
(Live, Tag, Woche, Monat). Bindet zusätzlich eine **Anker SOLIX V1 Wallbox (A5191)**
per Modbus TCP an — Auslesen ist umgesetzt, Steuerung (Laden) ist geplant.

## Architektur

```
Anker Cloud MQTT ─(5s)─▶ Collector (Python) ◀─(30s, Modbus TCP)─ Anker V1 Wallbox
                            │ INSERT + NOTIFY
                            ▼
                        TimescaleDB  ──▶ Backend (NestJS, REST + WebSocket)
                                            ▼
   Browser ◀── nginx (Angular + Proxy) ◀── Frontend (Angular + ngx-echarts)
```

NX-Monorepo:

| Pfad | Inhalt |
|------|--------|
| `apps/collector` | Python-Ingestion: Smart Meter (`anker-solix-api` via MQTT) **+ Wallbox (Modbus TCP)** |
| `apps/backend`   | NestJS: REST (`/api/meter`, `/api/wallbox`, `/api/tariff`) + WebSocket (Live) |
| `apps/frontend`  | Angular-Dashboard (ngx-echarts) |
| `libs/shared-types` | Geteilte TypeScript-Typen Backend ↔ Frontend |
| `db/init.sql`    | Hypertables, Continuous Aggregates, NOTIFY-Trigger |

> **Wallbox:** Die Anbindung ist **config-gesteuert** — der Collector pollt sie nur, wenn sie
> in den Einstellungen (UI) aktiviert ist (Name, IP, Port, Unit-ID, Intervall). Register-Map
> siehe `apps/collector/docs/anker-solix-v1-ev-charger-modbus-protocol-v1.0.0.pdf`
> (Messwerte FC4 ab 20000, Steuerregister FC3/6/16 ab 21000).

> Hinweis: Der Smart Meter läuft **standalone** (kein Power-System). Verfügbar sind nur
> Netzbezug (`grid_to_home_power`), Einspeisung/Überschuss (`pv_to_grid_power`) und die
> kumulativen Zählerstände — **keine** vollständige PV-Produktion/Hauslast.

## Konfiguration

`.env` im Repo-Root (siehe `.env.example`):

```
ANKERUSER="deine@mail.de"
ANKERPASSWORD="..."          # Sonderzeichen -> in Anfuehrungszeichen!
ANKERCOUNTRY="DE"
DATABASE_URL="postgresql://voltflow:voltflow@localhost:5432/voltflow"
```

## Entwicklung (lokal)

Nur die DB läuft im Container; Backend, Frontend und Collector laufen nativ mit
Hot-Reload (kein Docker-Image-Rebuild beim Entwickeln).

**Einmaliges Setup:**

```bash
# Python-venv + Abhängigkeiten
python3 -m venv venv && . venv/bin/activate
pip install cryptography aiohttp aiofiles paho-mqtt python-dotenv asyncpg
git clone https://github.com/thomluther/anker-solix-api.git
cd anker-solix-api && pip install --editable . && cd ..

# Node-Abhängigkeiten
npm ci
```

**Täglicher Dev-Workflow (npm-Scripts):**

```bash
npm run db          # TimescaleDB-Container starten (einmal, bleibt laufen)
npm run dev         # Backend (:3000) + Frontend (:4200) mit Hot-Reload
npm run collector   # Collector separat (schreibt Live-Werte in die DB)
# oder alles zusammen:
npm run dev:all     # Backend + Frontend + Collector parallel
```

Frontend: http://localhost:4200 (proxyt `/api` + `/socket.io` -> :3000).

> Hinweis: Es darf immer nur **ein** Collector pro Anker-Konto laufen (eine
> MQTT-Session). Den Prod-Stack-Collector also stoppen, wenn lokal entwickelt wird.

## Deployment (Raspberry Pi 5, arm64)

Alles als Container. Images werden nativ für arm64 gebaut (auf dem Pi selbst oder
auf einem Apple-Silicon-Mac; sonst `docker buildx --platform linux/arm64`).

```bash
# .env mit Credentials muss vorhanden sein
docker compose -f docker-compose.prod.yml up -d --build
# -> Dashboard: http://<pi>:8080
```

Services: `db` (TimescaleDB), `collector`, `backend`, `frontend` (nginx, Port 8080,
reverse-proxyt `/api` + `/socket.io` ans Backend). DB-Daten liegen im Volume `voltflow-db-data`.

## API

| Endpoint | Beschreibung |
|----------|--------------|
| `GET /api/meter/latest` | Letzter Messwert |
| `GET /api/meter/series?from&to&resolution=raw\|1min\|1hour\|1day` | Leistungs-Zeitreihe |
| `GET /api/meter/energy?period=day\|week\|month&date=YYYY-MM-DD` | kWh-Bezug/Einspeisung |
| `GET /api/meter/range` | Verfügbarer Datenzeitraum |
| `GET` / `PUT /api/tariff` | Stromtarif (Preise ct/kWh) |
| `GET` / `PUT /api/wallbox/config` | Wallbox-Verbindung (Name, IP, Port, Unit-ID, Intervall, an/aus) |
| `GET /api/wallbox/latest` | Letzter Wallbox-Messwert |
| `GET /api/wallbox/history?from&to` | Rohe Wallbox-Messwerte |
| `GET /api/wallbox/energy/daily?from&to` | Geladene Energie pro Tag (kWh) |
| WS-Event `reading` | Live-Messwert Smart Meter (~alle 5 s) |
| WS-Event `wallbox-reading` | Live-Wallbox-Wert (~alle 30 s) |

## Datensicherheit (Daten bleiben bei Updates erhalten)

Die Messdaten liegen im Docker-Volume `voltflow-db-data`, **getrennt** von den Containern.
App-Updates (`docker compose ... up -d --build`) ersetzen nur die Container — das Volume
bleibt. **Nie `docker compose down -v`** (löscht das Volume) verwenden.

**Schema-Änderungen:** `db/init.sql` läuft nur beim allerersten Start (leeres Volume).
Spätere additive Änderungen werden beim **Backend-Start idempotent** angewendet
(`apps/backend/src/app/database/schema.ts`, nur `… IF NOT EXISTS`) — so bekommen auch
bestehende DBs neue Tabellen/Spalten **ohne Datenverlust**.

**Backups** (das wichtigste Sicherheitsnetz):

```bash
./scripts/backup.sh                 # Dump nach ./backups/ (Rotation: 14 neueste)
./scripts/restore.sh backups/voltflow-YYYYMMDD-HHMMSS.sql.gz
# Prod (Pi):
COMPOSE_FILE=docker-compose.prod.yml COMPOSE_PROJECT_NAME=voltflow-prod ./scripts/backup.sh
```

Geplant z. B. per crontab auf dem Pi (täglich 3 Uhr):

```
0 3 * * * cd /home/pi/voltflow && COMPOSE_FILE=docker-compose.prod.yml \
  COMPOSE_PROJECT_NAME=voltflow-prod ./scripts/backup.sh >> backups/backup.log 2>&1
```

DB-Image ist exakt auf `timescale/timescaledb:2.28.1-pg16` gepinnt (PostgreSQL-Major **und**
TimescaleDB-Version). Upgrades nur bewusst: Tag hochziehen → Backup → `docker compose pull` →
`ALTER EXTENSION timescaledb UPDATE`. Ein PG-Major-Upgrade nur per Dump + Restore.

## Roadmap

- Wallbox **steuern**: Schreibzugriff auf die Modbus-Steuerregister (Start/Stop, Max-Strom,
  Phasen) für PV-Überschussladen (Auslesen ist bereits umgesetzt)
- Auth (aktuell für lokales Heimnetz ausgelegt)
