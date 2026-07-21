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
npm test            # vitest (unit tests for pure TS functions, *.spec.ts)
npm run typecheck   # tsc --build over the whole workspace
```

- venv + `anker-solix-api` (editable install) setup: see @README.md.
- **Tests:** `npm test` runs vitest (root `vitest.config.ts`, colocated
  `*.spec.ts` files). Covers pure functions only — no DB/HTTP/component tests.
  There is no lint runner and no pytest for the collector.
- **Typecheck:** always via `npm run typecheck` (`tsc --build`). A bare
  `tsc --noEmit -p <project>` does *not* rebuild the referenced `shared-types`
  project and reports phantom "has no exported member" errors against its stale
  `libs/shared-types/dist/*.d.ts`.

## Hard constraints

- **Only ONE _meter_ collector per Anker account** (a single MQTT session) — the
  `collector-meter` container / `COLLECTOR=meter`. Locally don't run `COLLECTOR=all`
  or `meter` while the prod meter collector is up, or the sessions collide
  (`COLLECTOR=sma`/`wallbox` are safe). sma/wallbox have no such limit.
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
wraps it in a `_run_<device>(pool, cfg)` task with reconnect logic.

`collector.py` runs one or all collectors, chosen by the **`COLLECTOR`** env
(`meter | sma | wallbox | all`). In prod each collector is its own slim image /
container (`Dockerfile.<device>`, `requirements-<device>.txt`, `COLLECTOR` baked
in) shipping only its own deps; `all` — the default, used by `npm run collector`
— runs all three in one process. Stream modules are therefore imported **lazily
inside** each `_run_*`, never at module top (the sma/wallbox images don't have
anker-solix-api/pymodbus). Config-gated collectors (sma/wallbox) run under
`_supervise(...)`, which polls `<device>_config` and starts/stops the task as the
device is enabled/disabled in the UI — no restart needed.

Adding a device: new `<device>_stream.py` + `_run_<device>` + a `COLLECTOR`
branch in `run()`; then `Dockerfile.<device>`, `requirements-<device>.txt`, a
`collector-<device>` service in `docker-compose.prod.yml`, and a deploy target in
`scripts/deploy.sh`.

→ **Template: `apps/collector/wallbox_stream.py`** (config-gated: only polls when
the device is enabled in the UI settings).

## Frontend conventions

- **Keep components small and focused.** Split a page/feature into per-section
  components, each owning its own state, instead of one large component. When
  building or reworking a view, prefer this decomposition over a monolith.
- **Factor shared UI into reusable, presentational components** under
  `apps/frontend/src/app/ui/` (e.g. `settings-card`, `toggle-switch`,
  `text-field`, `number-field`). Reach for an existing one before writing new
  markup; extract a new `ui/` component when the same pattern appears twice.
- Standalone components, co-located `*.component.ts/.html/.scss`. Use signal
  APIs (`input()` / `model()` / `linkedSignal`); two-way bind reusable controls
  via `[value]`/`(valueChange)`. Generic utilities (buttons, `.hint-sm`) live in
  the global `styles.scss`.

## Do not touch

- `anker-solix-api/` — vendored upstream repo (editable install), don't edit
- `venv/`, `node_modules/`, `dist/`, `.angular/`, `.nx/` — generated
- `backups/` — DB dumps
- `.env` — credentials, never commit (template: `.env.example`)
- `README.md` — the block between `<!-- HUMAN-WRITTEN:START -->` and
  `<!-- HUMAN-WRITTEN:END -->` is written and maintained solely by the repo owner;
  never edit, rewrite, or remove it, even as part of a broader README change.
