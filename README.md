# Voltflow

<!-- HUMAN-WRITTEN:START — Dieser Block wird ausschließlich vom Repo-Owner geschrieben
     und gepflegt. KI-Assistenten/Agenten (inkl. Claude Code) dürfen Inhalte zwischen
     diesen Markern nicht bearbeiten, umschreiben oder entfernen. -->

## ✍️ Some notes *(human written)*

This app is very specific to my home and wasn't planned to be more generic and support other devices, the abstraction is missing ... so far, who knows.
I created this project mainly to try coding with Claude Code. Me, a Senior Software Develloper telling AI what to code, and sometimes how to do it better.
Results are pretty good for the given requirements and complexity of the app. I also deployed it now on a Raspberry PI and let it track and visualize my homes energy flow. Of course no replacement for Home Assistant.

<!-- HUMAN-WRITTEN:END -->

## Funktion

Erfasst die Live-Werte des **Anker Solix Smart Meters (A17X7)** über den MQTT-Cloud-Server,
speichert sie in **TimescaleDB** und stellt sie in einer Web-App grafisch dar
(Live, Tag, Woche, Monat). Bindet zusätzlich eine **Anker SOLIX V1 Wallbox (A5191)**
per Modbus TCP und einen **SMA PV-Wechselrichter (STP 6000TL-20)** per Speedwire an.

> **Highlight:** Erst mit der PV-Produktion (SMA) **und** dem Smart Meter lässt sich die
> echte **Hauslast** (PV + Netzbezug − Einspeisung) und daraus **Eigenverbrauch & Autarkie**
> ableiten — ohne Produktionsdaten war das vorher nicht möglich.

## Architektur

```
Anker Cloud MQTT ─(5s)──▶ Collector (Python) ◀─(30s, Modbus TCP)── Anker V1 Wallbox
SMA Inverter ─(60s, Speedwire)─▶ │ INSERT + NOTIFY
                                 ▼
                             TimescaleDB  ──▶ Backend (NestJS, REST + WebSocket)
                                                 ▼
   Browser ◀── nginx (Angular + Proxy) ◀──── Frontend (Angular + ngx-echarts)
```

NX-Monorepo:

| Pfad | Inhalt |
|------|--------|
| `apps/collector` | Python-Ingestion: Smart Meter (`anker-solix-api`/MQTT) **+ Wallbox (Modbus)** **+ SMA (Speedwire/`pysma-plus`)** |
| `apps/backend`   | NestJS: REST (`/api/meter`, `/api/wallbox`, `/api/sma`, `/api/tariff`, `/api/system`) + WebSocket (Live) |
| `apps/frontend`  | Angular-Dashboard (ngx-echarts) |
| `libs/shared-types` | Geteilte TypeScript-Typen Backend ↔ Frontend |
| `db/init.sql`    | Hypertables, Continuous Aggregates, NOTIFY-Trigger |

> **SMA-Wechselrichter:** config-gesteuert (Name, IP, Intervall, an/aus in der UI), Passwort
> aus `SMA_PASSWORD` (.env). Nachts schläft der Wechselrichter → wird als `asleep` (0 W)
> erfasst, `daily_yield` wird bis Mitternacht weitergetragen. Die **Hauslast** entsteht als
> reine VIEW `house_load_1min` aus den 1‑Min-Caggs von Meter **und** SMA (Caggs können nicht
> über Hypertables joinen) — so wird der 5s‑vs‑60s‑Sampling-Mismatch auf einem Raster geglättet.

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
npm test            # Unit-Tests (vitest, pure TS-Funktionen)
```

Frontend: http://localhost:4200 (proxyt `/api` + `/socket.io` -> :3000).

**CI:** GitHub Actions (`.github/workflows/ci.yml`) läuft bei jedem Push auf `main` und
bei jedem PR: `npm ci` → `npm test` (vitest) → `nx run-many -t build` (Backend + Frontend).

> Hinweis: Es darf immer nur **ein** Collector pro Anker-Konto laufen (eine
> MQTT-Session). Den Prod-Stack-Collector also stoppen, wenn lokal entwickelt wird.

## Deployment (Ubuntu-Server, amd64)

Alles als Container. Die Images werden auf einem Dev-Rechner (z. B. Apple-Silicon-Mac)
für `linux/amd64` cross-gebaut und **ohne Registry** per `docker save | ssh | docker load`
auf den Server übertragen. Der Server braucht nur das Bundle (`docker-compose.prod.yml` +
`.env` + `db/init.sql` + `certs/`) — **keinen Source-Tree und keinen Build**.

**Komfort-Wrapper** (kapselt alle Schritte unten, niemals `down`/`-v`, DB-Volume bleibt unangetastet):

```bash
scripts/deploy.sh app         # nur Backend + Frontend (UI/API-Update, Collectors laufen weiter)
scripts/deploy.sh all         # ganzer Stack (3 Collectors + Backend + Frontend), ohne Datenverlust
scripts/deploy.sh collector   # alle drei Collector-Container
scripts/deploy.sh collector-sma   # nur ein einzelner Collector (meter|sma|wallbox)
scripts/deploy.sh --help      # Optionen: einzelne Services, --env, --prune, --dry-run
```

Die einzelnen Schritte, die der Wrapper ausführt:

```bash
# 1) Auf dem Dev-Rechner: amd64-Images bauen
docker buildx bake -f docker-compose.prod.yml --set '*.platform=linux/amd64' --load

# 2) Images auf den Server übertragen (kein Registry nötig)
docker save voltflow-collector-meter voltflow-collector-sma voltflow-collector-wallbox \
  voltflow-backend voltflow-frontend | gzip | ssh <server> 'gunzip | docker load'

# 3) Bundle auf den Server (einmalig bzw. bei Änderung)
ssh <server> 'mkdir -p ~/voltflow/db ~/voltflow/certs'
scp docker-compose.prod.yml .env <server>:~/voltflow/
scp db/init.sql <server>:~/voltflow/db/
scp certs/voltflow.crt certs/voltflow.key <server>:~/voltflow/certs/   # nginx startet ohne Zertifikat nicht
ssh <server> 'chmod 644 ~/voltflow/certs/voltflow.key'                 # non-root nginx muss den Key lesen können

# 4) Auf dem Server starten/aktualisieren
ssh <server> 'cd ~/voltflow && docker compose -f docker-compose.prod.yml up -d'
# -> Dashboard: https://<server> (Port 8080 redirect auf HTTPS)
```

`docker-compose.prod.yml` referenziert die App-Images mit `image:`-Tags + `pull_policy: never`,
sodass der Server sie aus dem `docker load` nutzt (kein Build, kein Registry-Pull). `db` zieht
`timescale/timescaledb:2.28.1-pg16` direkt (multi-arch). Alle Services laufen mit
`restart: unless-stopped` (überleben Server-Reboot).

Services: `db` (TimescaleDB), die drei Collector-Container `collector-meter` / `collector-sma` /
`collector-wallbox`, `backend`, `frontend` (nginx, terminiert TLS auf Port 443/8443 und
reverse-proxyt `/api` + `/socket.io` ans Backend; Port 8080 redirected auf HTTPS).
DB-Daten liegen im Volume `voltflow-db-data`.

**Collector-Aufteilung:** Jedes Gerät läuft in einem eigenen, schlanken Image — `collector-meter`
(Anker-MQTT), `collector-sma` (Speedwire) und `collector-wallbox` (Modbus) — mit je nur den eigenen
Abhängigkeiten (nur `meter` braucht `git` + `anker-solix-api`). Welchen Collector ein Container
startet, steuert die im Image gesetzte `COLLECTOR`-Env; lokal ohne `COLLECTOR` läuft weiterhin alles
in einem Prozess (`npm run collector`). Nur `collector-meter` unterliegt der Anker-Single-Session-Regel.
Beim ersten `all`-Deploy nach der Aufteilung entfernt `scripts/deploy.sh` den alten Monolith-Container
`collector` automatisch (`--remove-orphans`), damit keine zweite Anker-Session entsteht.

**HTTPS-Zertifikat (mkcert, lokales Netz):** `certs/voltflow.crt` + `certs/voltflow.key` liegen
lokal (gitignored) und werden von `scripts/deploy.sh` mit ins Bundle nach `~/voltflow/certs/`
kopiert. Neu erzeugen bei IP-/Hostnamewechsel:

```bash
mkcert -cert-file certs/voltflow.crt -key-file certs/voltflow.key <server-ip> voltflow.local localhost 127.0.0.1
```

Damit Browser/Geräte im Netz dem Zertifikat vertrauen, einmalig die mkcert-Root-CA installieren
(`$(mkcert -CAROOT)/rootCA.pem`, z.B. auf dem Mac via `mkcert -install`, auf anderen Geräten
manuell als vertrauenswürdiges Root-Zertifikat importieren).

> **Nach Zertifikat-Neuerzeugung:** nginx liest das Zertifikat nur beim Container-Start —
> ein `docker compose up -d` ohne Image-Änderung wendet ein neues Zertifikat **nicht** an.
> Auf dem Server einmal `docker compose -f docker-compose.prod.yml restart frontend` ausführen.

> **Bestehende DB migrieren:** Dump auf der Quelle ziehen (`scripts/backup.sh`), auf den Server
> kopieren und in eine **frische** DB restoren (`scripts/restore.sh`, TimescaleDB-aware via
> `pre_restore`/`post_restore`). Da das Backend beim Start das Schema idempotent anlegt, vor dem
> Restore `DROP DATABASE … WITH (FORCE)` + neu anlegen (Backend kurz stoppen), sonst kollidiert
> der Dump mit dem bestehenden Schema. Quell- und Ziel-TimescaleDB-Version müssen übereinstimmen.

> **Nur ein Collector pro Anker-Konto:** Sobald der Server-Collector läuft, darf lokal keiner
> mehr laufen (eine MQTT-Session). Lokalen Collector-Container ggf. mit
> `docker update --restart=no <name>` gegen Auto-Restart sichern.

## API

| Endpoint | Beschreibung |
|----------|--------------|
| `GET /api/meter/latest` | Letzter Messwert |
| `GET /api/meter/series?from&to&resolution=raw\|1min\|1hour\|1day` | Leistungs-Zeitreihe |
| `GET /api/meter/energy?period=day\|week\|month&date=YYYY-MM-DD` | kWh-Bezug/Einspeisung |
| `GET /api/meter/range` | Verfügbarer Datenzeitraum |
| `GET` / `POST` / `PUT` / `DELETE /api/meter-checkpoints` | Manuelle Zählerstände (Abgleich mit dem physischen Zähler) |
| `GET /api/meter-checkpoints/reconciliation` | Abgleich der Zählerstände mit dem SmartMeter + Hochrechnung |
| `GET` / `PUT /api/tariff` | Stromtarif (Preise ct/kWh) |
| `GET` / `PUT /api/wallbox/config` | Wallbox-Verbindung (Name, IP, Port, Unit-ID, Intervall, an/aus) |
| `GET /api/wallbox/latest` | Letzter Wallbox-Messwert |
| `GET /api/wallbox/history?from&to` | Rohe Wallbox-Messwerte |
| `GET /api/wallbox/energy/daily?from&to` | Geladene Energie pro Tag (kWh) |
| `GET /api/wallbox/energy/hourly?from&to` | Geladene Energie pro Stunde (kWh, Tagesansicht) |
| `GET` / `PUT /api/sma/config` | SMA-Verbindung (Name, IP, Intervall, an/aus) |
| `GET /api/sma/latest` | Letzter SMA-Messwert |
| `GET /api/sma/history?from&to` | Rohe SMA-Messwerte |
| `GET /api/sma/energy/daily?from&to` | PV-Ertrag pro Tag (kWh) |
| `GET /api/sma/power/minute?from&to` | PV-Leistung pro Minute (W, Tagesansicht) |
| `GET /api/sma/house-load?from&to` | Abgeleitete Hauslast-Zeitreihe (W) |
| `GET /api/sma/balance?from&to` | Energiebilanz: Eigenverbrauch & Autarkie |
| `GET /api/system/health` | Host-Health (Load/RAM/Disk) + Container-Liste (Admin-Tab „System", nicht persistiert) |
| WS-Event `reading` | Live-Messwert Smart Meter (~alle 5 s) |
| WS-Event `wallbox-reading` | Live-Wallbox-Wert (~alle 30 s) |
| WS-Event `sma-reading` | Live-SMA-Wert (~alle 60 s) |

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
# Prod (Server) — Projektname ist der Verzeichnisname (voltflow), scripts/ muss
# neben dem Bundle in ~/voltflow/scripts/ liegen:
COMPOSE_FILE=docker-compose.prod.yml ./scripts/backup.sh
```

Geplant z. B. per crontab auf dem Server (täglich 3 Uhr):

```
0 3 * * * cd ~/voltflow && COMPOSE_FILE=docker-compose.prod.yml \
  ./scripts/backup.sh >> backups/backup.log 2>&1
```

DB-Image ist exakt auf `timescale/timescaledb:2.28.1-pg16` gepinnt (PostgreSQL-Major **und**
TimescaleDB-Version). Upgrades nur bewusst: Tag hochziehen → Backup → `docker compose pull` →
`ALTER EXTENSION timescaledb UPDATE`. Ein PG-Major-Upgrade nur per Dump + Restore.

## Roadmap

- Wallbox **steuern**: Schreibzugriff auf die Modbus-Steuerregister (Start/Stop, Max-Strom,
  Phasen) für PV-Überschussladen (Auslesen ist bereits umgesetzt)
- Auth (aktuell für lokales Heimnetz ausgelegt)

