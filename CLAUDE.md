# CLAUDE.md

Voltflow ingests live readings from an Anker Solix smart meter (MQTT cloud), an
Anker V1 wallbox (Modbus TCP) and an SMA PV inverter (Speedwire), stores them in
TimescaleDB and renders them in an Angular web app.

Full architecture, API table and deployment: see @README.md.

## Stack

- **NX 23** monorepo (npm workspaces), TypeScript 5.9
- `apps/backend` — NestJS 11, REST + WebSocket, `pg`
- `apps/frontend` — Angular 21, ngx-echarts
- `apps/collector` — Python (asyncio), **not** NX/Node — runs in the `venv`
- `libs/shared-types` — shared TS types between backend and frontend
- DB: TimescaleDB, pinned to `timescale/timescaledb:2.28.1-pg16`

## Dev commands

```bash
npm run db          # DB container only (leave it running)
npm run dev         # backend :3000 + frontend :4200 (native hot-reload)
npm run dev:all     # + collector in parallel
npm run collector   # collector alone (venv/bin/python)
```

- venv + `anker-solix-api` (editable install) setup: see @README.md.
- **There is no test/lint runner** (no jest/vitest/pytest, no `test` targets).
  Do not invent test commands or claim to run tests.

## Hard constraints

- **Only ONE collector per Anker account** (a single MQTT session). When developing
  locally, stop the prod collector or the sessions collide.
- **Never `docker compose down -v`** — it deletes the `voltflow-db-data` volume
  with all measurement data.
- **Schema changes belong in `apps/backend/src/app/database/schema.ts`**
  (idempotent, `… IF NOT EXISTS` only) so existing DBs get them without data loss.
  `db/init.sql` runs only on the very first start (empty volume).
- **Continuous aggregates:** when deriving house load (PV + grid import − feed-in),
  reconcile the sources' sampling mismatch over shared time buckets — do not join
  raw values.
- Keep backend ↔ frontend types in sync via `libs/shared-types`.

## Collector pattern (adding a new device)

Each device is its own `apps/collector/<device>_stream.py` exporting an
**async generator** `stream_<device>(...)` that yields readings. `collector.py`
wraps it in a `_run_<device>(pool, cfg)` task with reconnect logic and gathers all
tasks in `run()` via `asyncio.gather`.

→ **Template: `apps/collector/wallbox_stream.py`** (config-gated: only polls when
the device is enabled in the UI settings).

## Do not touch

- `anker-solix-api/` — vendored upstream repo (editable install), don't edit
- `venv/`, `node_modules/`, `dist/`, `.angular/`, `.nx/` — generated
- `backups/` — DB dumps
- `.env` — credentials, never commit (template: `.env.example`)
