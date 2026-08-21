"""
collector.py - Streams device readings into the DB.

Which collectors run is selected by the COLLECTOR env var:
    meter | sma | wallbox   -> only that collector  (one per prod container)
    all (default)           -> all three in one process (dev: npm run collector)

Start (locally, in the root venv, all collectors):
    python apps/collector/collector.py

Configuration via .env / env:
    COLLECTOR (default "all")
    ANKERUSER, ANKERPASSWORD, ANKERCOUNTRY   (meter)
    SMA_PASSWORD                             (sma)
    DATABASE_URL=postgresql://voltflow:voltflow@localhost:5432/voltflow
"""

import asyncio
import contextlib
import logging
import os
import signal
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

__version__ = (Path(__file__).parent / "VERSION").read_text().strip()

from db import (
    bind_device_sn,
    create_pool,
    insert_reading,
    insert_sma_reading,
    insert_wallbox_reading,
    last_sma_reading,
    read_device_configs,
    register_device,
)
# Stream modules are imported lazily inside each _run_* function so a single
# collector image only needs its own heavy deps (e.g. the sma/wallbox images
# ship without anker-solix-api / pymodbus).

# Local timezone for the daily_yield day boundary (matches the DB day buckets).
_TZ = ZoneInfo("Europe/Berlin")
# Power fields zeroed in an asleep row written when the inverter is unreachable.
_SMA_POWER_FIELDS = ("grid_power", "pv_power_a", "pv_power_b", "power_l1", "power_l2", "power_l3")

load_dotenv()

# Which collector(s) this process runs: meter | sma | wallbox | all (default).
# Prod runs one per container (COLLECTOR set in each image); dev runs "all".
COLLECTOR = os.getenv("COLLECTOR", "all").lower()

logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
LOG = logging.getLogger("voltflow.collector")
LOG.setLevel(logging.INFO)
# The stream modules log their own operational breadcrumbs (session established,
# inverter idle rather than half-dead) at INFO. Without this they stay invisible
# under the WARNING root level, which is how "SMA connected" never showed up in
# prod - and an explanation nobody can read is no explanation.
logging.getLogger("voltflow.sma").setLevel(logging.INFO)
LOG.info("Voltflow collector %s starting (COLLECTOR=%s)", __version__, COLLECTOR)

# Seconds before reconnecting if a stream breaks
RECONNECT_DELAY = 10
# Seconds between config polls for gated collectors (sma/wallbox)
CONFIG_POLL_S = 30


def _apply_daily_carry(carry: dict, snap: dict, today, production_fields) -> None:
    """Fill daily_yield_wh / total_yield_kwh on a snapshot from carry state.

    daily_yield_wh restarts at 0 each local day. The inverter keeps reporting the
    PREVIOUS day's daily_yield through the night until its own reset at first
    production (NOT at local midnight), so a real read early in a new day would
    otherwise carry yesterday's kWh into today. Guard: today's daily_yield stays
    0 until the inverter has actually produced today (any of grid_power /
    pv_power_a / pv_power_b > 0 - not grid_power alone, which a single lossy
    Speedwire read can drop while the PV fields still arrive); only then are
    reported values trusted. total_yield_kwh is a monotonic lifetime counter,
    carried verbatim when a read is missing it.

    `production_fields` is sma_stream.PRODUCTION_FIELDS, passed in rather than
    imported at module level so this module stays importable without
    pysma-plus (the meter/wallbox images ship without it).
    """
    if carry["date"] != today:
        carry["date"], carry["daily_wh"], carry["produced"] = today, 0.0, False
    if any((snap.get(f) or 0) > 0 for f in production_fields):
        carry["produced"] = True

    reported = snap.get("daily_yield_wh")
    if reported is not None and carry["produced"]:
        carry["daily_wh"] = float(reported)
    # Before the first production of the day (stale night reads) or on an asleep
    # read, keep the carried value: 0 early in a new day, today's total later.
    snap["daily_yield_wh"] = carry["daily_wh"]

    if snap.get("total_yield_kwh") is not None:
        carry["total_kwh"] = float(snap["total_yield_kwh"])
    elif carry["total_kwh"] is not None:
        snap["total_yield_kwh"] = carry["total_kwh"]


async def _create_pool_with_retry():
    """Build the pool; retry if the DB is not (yet) reachable."""
    while True:
        try:
            return await create_pool()
        except Exception as err:  # noqa: BLE001
            LOG.warning("DB not reachable (%s) - retrying in %ss",
                        type(err).__name__, RECONNECT_DELAY)
            await asyncio.sleep(RECONNECT_DELAY)


async def _run_with_reconnect(label: str, stream_factory, on_reading) -> None:
    """Drain an async-generator stream forever, reconnecting after
    RECONNECT_DELAY on any error. Shared by _run_meter and _run_wallbox, which
    differ only in the stream factory and what a reading does once read.

    A failure inside `on_reading` (i.e. writing to the DB) drops that one
    reading and keeps the stream open, exactly as _run_sma does: the device
    session is not what failed, and tearing it down would mean the meter opens
    a brand-new Anker MQTT session over a transient Postgres blip - churn
    against an account that permits only one. Only the stream itself failing
    triggers a reconnect.

    Uses contextlib.aclosing so the generator's own `finally` (closing the
    MQTT/Modbus session) always runs synchronously before reconnecting - an
    `async for` abandoned via an exception in its body does not call aclose()
    itself; without this, cleanup is deferred to whenever the event loop's GC
    finalizer happens to schedule it, which is not guaranteed to happen before
    the next connection attempt.
    """
    while True:
        try:
            async with contextlib.aclosing(stream_factory()) as stream:
                async for reading in stream:
                    try:
                        await on_reading(reading)
                    except Exception as db_err:  # noqa: BLE001
                        LOG.warning("%s reading dropped (DB error: %s: %s)",
                                    label, type(db_err).__name__, db_err)
        except Exception as err:  # noqa: BLE001
            LOG.warning("%s stream error: %s: %s - reconnecting in %ss",
                        label, type(err).__name__, err, RECONNECT_DELAY)
            await asyncio.sleep(RECONNECT_DELAY)


async def _run_meter(pool) -> None:
    """Continuously stream smart meter readings into the DB (with reconnect)."""
    from meter_stream import stream_readings

    device_registered = False
    count = 0

    async def on_reading(reading: dict) -> None:
        nonlocal device_registered, count
        if not device_registered:
            await register_device(pool, reading, "smartmeter")
            device_registered = True
        await insert_reading(pool, reading)
        count += 1
        if count % 12 == 0:  # ~one status line per minute
            LOG.info(
                "%d meter readings stored (latest: g2h=%s pv2g=%s)",
                count,
                reading.get("grid_to_home_power"),
                reading.get("pv_to_grid_power"),
            )

    await _run_with_reconnect("Meter", lambda: stream_readings(interval=5), on_reading)


async def _bind_config(pool, cfg: dict, snap: dict) -> None:
    """Bind the config row to the serial found at its address, once.

    Skipped when the row is already bound, so this stays a first-contact event:
    re-binding on every restart would let a config row silently change which
    physical device it means. Never fatal - a failed binding costs a link in the
    UI, not a reading.
    """
    device_sn = snap.get("device_sn")
    if not device_sn or cfg.get("device_sn") or cfg.get("id") is None:
        return
    try:
        await bind_device_sn(pool, cfg["id"], device_sn)
        cfg["device_sn"] = device_sn  # do not try again this run
    except Exception as err:  # noqa: BLE001 - binding must never stop collecting
        LOG.warning("could not bind config #%s to %s (%s: %s)",
                    cfg.get("id"), device_sn, type(err).__name__, err)


async def _run_wallbox(pool, cfg: dict) -> None:
    """Continuously poll the wallbox via Modbus into the DB (with reconnect)."""
    from wallbox_stream import stream_wallbox

    host = cfg["host"]
    port = cfg.get("port") or 502
    unit_id = cfg.get("unit_id") or 1
    interval = cfg.get("poll_interval_s") or 30
    device_registered = False
    count = 0
    last_reading_at: float | None = None  # monotonic clock, for energy_wh below

    async def on_reading(snap: dict) -> None:
        nonlocal device_registered, count, last_reading_at
        # Energy since the PREVIOUS reading, from the actual elapsed wall-clock
        # time rather than the configured poll interval - correct regardless of
        # its exact value (poll_interval_s is user-adjustable, 5-3600s) and
        # immune to gaps around a reconnect, unlike integrating at a fixed
        # assumed rate. Capped at 2x the interval so a long gap (collector
        # restart, wallbox offline) is not integrated as one implausible energy
        # spike on the first reading back.
        now = asyncio.get_running_loop().time()
        elapsed_s = min(now - last_reading_at, 2 * interval) if last_reading_at is not None else 0.0
        last_reading_at = now
        power = snap.get("active_power_w")
        snap["energy_wh"] = (power * elapsed_s / 3600) if snap.get("status") == 2 and power is not None else 0.0

        if not device_registered:
            await register_device(pool, snap, "wallbox")
            await _bind_config(pool, cfg, snap)
            device_registered = True
        await insert_wallbox_reading(pool, snap)
        count += 1
        LOG.info(
            "wallbox reading #%d stored (status=%s power=%sW)",
            count, snap.get("status"), snap.get("active_power_w"),
        )

    await _run_with_reconnect(
        "Wallbox",
        lambda: stream_wallbox(host, port=port, unit_id=unit_id, interval=interval),
        on_reading,
    )


async def _run_sma(pool, cfg: dict, password: str) -> None:
    """Continuously poll the SMA inverter into the DB.

    Night-safe: a sleeping/unreachable inverter is written as an `asleep` row
    (0 W) with the daily_yield carried over within the same local day, instead
    of crashing or spamming the log. Logs only on wake<->sleep transitions.

    Reconnects do NOT record 0 W by themselves. A broken session is routine
    (pysma-plus drops its Speedwire socket several times a day) and used to be
    written as an asleep row on the spot, which is what put zero spikes into the
    middle of a sunny afternoon. The same `sleep_implausible` rule the stream
    applies internally is applied here, so a reconnect out of real production
    leaves a gap until the inverter answers again.
    """
    from sma_stream import (
        PRODUCTION_FIELDS,
        SmaSessionStale,
        sleep_implausible,
        stream_sma,
    )

    host = cfg["host"]
    interval = cfg.get("poll_interval_s") or 60

    # Carry state (seeded from the DB so a night restart keeps today's yield).
    carry = {"date": None, "daily_wh": None, "total_kwh": None,
             "produced": False, "serial": None, "model": None,
             "last_power": None}
    try:
        seed = await last_sma_reading(pool)
    except Exception as err:  # noqa: BLE001 - seed must never crash the collector
        LOG.warning("SMA seed read failed (%s: %s) - continuing without carry",
                    type(err).__name__, err)
        seed = None
    if seed:
        carry["serial"] = seed.get("device_sn")
        carry["model"] = seed.get("device_pn")
        if seed.get("grid_power") is not None:
            carry["last_power"] = float(seed["grid_power"])
        if seed.get("total_yield_kwh") is not None:
            carry["total_kwh"] = float(seed["total_yield_kwh"])
        if seed.get("time") is not None and seed.get("daily_yield_wh") is not None:
            carry["date"] = seed["time"].astimezone(_TZ).date()
            carry["daily_wh"] = float(seed["daily_yield_wh"])
            # A non-zero yield for today means the inverter already produced
            # today, so later reads are trusted straight away after a restart.
            carry["produced"] = carry["daily_wh"] > 0

    registered = False
    awake = None  # None = unknown; for wake/sleep transition logging

    def log_transition(snap: dict) -> None:
        nonlocal awake
        now_awake = not snap.get("asleep")
        if awake is None or now_awake != awake:
            if now_awake:
                LOG.info("SMA awake: grid_power=%sW daily_yield=%sWh",
                         snap.get("grid_power"), snap.get("daily_yield_wh"))
            else:
                LOG.info("SMA asleep: 0 W, daily_yield carried=%sWh",
                         snap.get("daily_yield_wh"))
            awake = now_awake

    fail_cycles = 0   # consecutive failed reconnects, for sleep_implausible
    gapping = False   # logged once per gap run

    while True:
        try:
            async with contextlib.aclosing(stream_sma(host, password, interval=interval)) as stream:
                async for snap in stream:
                    carry["serial"] = snap.get("device_sn") or carry["serial"]
                    carry["model"] = snap.get("device_pn") or carry["model"]
                    # Keep the last known level when a read omits grid_power alone -
                    # that is still production, not "unknown" (see sleep_implausible).
                    if snap.get("asleep"):
                        carry["last_power"] = 0.0
                    elif snap.get("grid_power") is not None:
                        carry["last_power"] = snap["grid_power"]
                    fail_cycles, gapping = 0, False
                    _apply_daily_carry(carry, snap, datetime.now(_TZ).date(), PRODUCTION_FIELDS)
                    # DB errors are kept out of the except-Exception block below,
                    # which is written for SMA session/device failures: a pool
                    # hiccup here must not be misread as "inverter unreachable"
                    # and, on a snap that is legitimately below
                    # PRODUCING_ABOVE_W, fabricate an asleep (0 W) row for a
                    # device that was never actually the problem.
                    try:
                        if not registered:
                            await register_device(pool, snap, "inverter")
                            await _bind_config(pool, cfg, snap)
                            registered = True
                        await insert_sma_reading(pool, snap)
                    except Exception as db_err:  # noqa: BLE001
                        LOG.warning("SMA reading dropped (DB error: %s: %s)",
                                    type(db_err).__name__, db_err)
                        continue
                    log_transition(snap)
        except SmaSessionStale as err:
            # The stream asked for a fresh session while the inverter is still
            # reachable. Nothing is wrong with the device, so record nothing and
            # reconnect at once - the next session normally reads fine.
            LOG.info("SMA session recycled (%s) - reconnecting", err)
            continue
        except Exception as err:  # noqa: BLE001
            # Session could not be (re)established -> night/unreachable, or a
            # dropped Speedwire socket. Persist an asleep row (carried yield)
            # only if 0 W is plausible: after a reconnect out of real production
            # it is not, and a gap is recorded instead. Retry at the poll
            # interval and log only on the wake->sleep transition.
            fail_cycles += 1
            if carry["serial"] and sleep_implausible(carry["last_power"], fail_cycles):
                if not gapping:
                    LOG.warning(
                        "SMA reconnect failed while producing (last %.0f W, "
                        "%s: %s) - recording a gap, not 0 W",
                        carry["last_power"], type(err).__name__, err)
                    gapping = True
            elif carry["serial"]:
                gapping = False
                carry["last_power"] = 0.0
                snap = {f: 0.0 for f in _SMA_POWER_FIELDS}
                snap.update(asleep=True, device_sn=carry["serial"], device_pn=carry["model"])
                _apply_daily_carry(carry, snap, datetime.now(_TZ).date(), PRODUCTION_FIELDS)
                try:
                    await insert_sma_reading(pool, snap)
                except Exception:  # noqa: BLE001
                    pass
                log_transition(snap)
            elif awake is not False:
                LOG.info("SMA not reachable yet (%s: %s) - retrying every %ss",
                         type(err).__name__, err, interval)
                awake = False
            await asyncio.sleep(interval)


# Which device_config.driver values each COLLECTOR value is responsible for.
#
# The driver is the third axis of the device model (role / driver / instance):
# it names the protocol, and therefore which stream module has to be importable.
# That is why the mapping lives here rather than in the DB - the prod images are
# split per collector and only ship their own heavy deps, so a container must
# never pick up a row whose driver it cannot actually talk (the sma/wallbox
# images have no anker-solix-api, the meter image no pymodbus).
#
# The meter is deliberately absent: it is not config-gated. Its credentials are
# env-only (they do not belong in the DB) and it has no address to configure, so
# there is no row for it to be enabled or disabled by.
DRIVERS_BY_COLLECTOR: dict[str, list[str]] = {
    "sma": ["sma-speedwire"],
    "wallbox": ["anker-v1-modbus"],
}


async def _supervise_instances(pool, kind: str, drivers: list[str], run_factory) -> None:
    """Run one collector task per enabled `device_config` row for these drivers.

    Replaces the old one-config-per-device supervisor: the unit of work is now a
    configured *instance*, so two wallboxes are two rows and therefore two
    tasks. Polls every CONFIG_POLL_S seconds and reconciles the running tasks
    against the rows - starting new ones, restarting those whose connection
    settings changed, stopping those disabled or deleted. No process restart is
    needed to pick up a device configured later in the UI.

    Rows aimed at the same target are collapsed to one task. A user can quite
    reasonably end up with two rows pointing at one address (a duplicate while
    renaming, a second row added before the first was removed), and starting two
    tasks against one device is not a cosmetic problem: two Modbus sessions
    against the same unit fight over the wallbox's 120-second watchdog register.
    """
    tasks: dict[int, asyncio.Task] = {}
    active_keys: dict[int, tuple] = {}
    waiting_logged = False
    missing_table_logged = False
    dup_logged: set[tuple] = set()

    def key_of(cfg: dict) -> tuple:
        # A change to any of these requires restarting the underlying stream.
        return (cfg.get("host"), cfg.get("port"),
                cfg.get("unit_id"), cfg.get("poll_interval_s"))

    def target_of(cfg: dict) -> tuple:
        # What the row points at, ignoring how often it is polled.
        return (cfg.get("host"), cfg.get("port"), cfg.get("unit_id"))

    async def stop(config_id: int) -> None:
        task = tasks.pop(config_id, None)
        active_keys.pop(config_id, None)
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception as err:  # noqa: BLE001
            # The _run_* functions catch broadly internally, so this only fires
            # for a bug that escapes them - but when it does, silently
            # swallowing it is exactly what makes that class of bug invisible
            # in production.
            LOG.error("%s collector task #%s ended with an unexpected error: %s: %s",
                      kind, config_id, type(err).__name__, err)

    async def stop_all() -> None:
        for config_id in list(tasks):
            await stop(config_id)

    try:
        while True:
            try:
                rows = await read_device_configs(pool, drivers)
            except Exception as err:  # noqa: BLE001 - a config read must not kill the loop
                LOG.warning("%s config read failed (%s: %s) - retrying",
                            kind, type(err).__name__, err)
                rows = []

            if rows is None:
                # Table absent: the backend has not applied its migrations yet.
                # Distinct from "no rows" - that is a normal idle state, this is
                # a deploy that has not finished, and it silences every device.
                if not missing_table_logged:
                    LOG.warning("%s: device_config does not exist yet - waiting for "
                                "the backend to migrate", kind)
                    missing_table_logged = True
                rows = []
            else:
                missing_table_logged = False

            usable: dict[int, dict] = {}
            seen_targets: dict[tuple, int] = {}
            for cfg in rows:
                if not cfg.get("host"):
                    continue  # enabled but not reachable yet; nothing to start
                target = target_of(cfg)
                first = seen_targets.get(target)
                if first is not None:
                    if target not in dup_logged:
                        LOG.warning("%s: config #%s targets the same device as #%s (%s) "
                                    "- running only #%s",
                                    kind, cfg["id"], first, cfg.get("host"), first)
                        dup_logged.add(target)
                    continue
                seen_targets[target] = cfg["id"]
                usable[cfg["id"]] = cfg
            dup_logged &= set(seen_targets)

            # Stop what is no longer wanted (disabled, deleted, or deduplicated).
            for config_id in list(tasks):
                if config_id not in usable:
                    LOG.info("%s #%s disabled - stopping collector", kind, config_id)
                    await stop(config_id)

            # Start or restart what is.
            for config_id, cfg in usable.items():
                new_key = key_of(cfg)
                task = tasks.get(config_id)
                if task is not None and (task.done() or new_key != active_keys.get(config_id)):
                    await stop(config_id)
                    task = None
                if task is None:
                    LOG.info("%s #%s enabled (%s%s) - starting collector",
                             kind, config_id, cfg["host"],
                             f' "{cfg["name"]}"' if cfg.get("name") else "")
                    tasks[config_id] = asyncio.create_task(run_factory(pool, cfg))
                    active_keys[config_id] = new_key
                    waiting_logged = False

            if not tasks and not waiting_logged:
                LOG.info("%s not enabled - waiting; auto-starts when enabled in the UI", kind)
                waiting_logged = True

            await asyncio.sleep(CONFIG_POLL_S)
    finally:
        await stop_all()


async def run() -> None:
    valid = {"all", "meter", "sma", "wallbox"}
    if COLLECTOR not in valid:
        LOG.error("Invalid COLLECTOR=%r (expected one of %s)", COLLECTOR, sorted(valid))
        return

    pool = await _create_pool_with_retry()
    try:
        tasks: list[asyncio.Task] = []

        if COLLECTOR in ("all", "meter"):
            tasks.append(asyncio.create_task(_run_meter(pool)))

        if COLLECTOR in ("all", "sma"):
            sma_password = os.getenv("SMA_PASSWORD")
            if not sma_password:
                LOG.warning("SMA_PASSWORD not set - SMA collector disabled")
            else:
                tasks.append(asyncio.create_task(_supervise_instances(
                    pool, "SMA", DRIVERS_BY_COLLECTOR["sma"],
                    lambda p, c: _run_sma(p, c, sma_password))))

        if COLLECTOR in ("all", "wallbox"):
            tasks.append(asyncio.create_task(_supervise_instances(
                pool, "Wallbox", DRIVERS_BY_COLLECTOR["wallbox"], _run_wallbox)))

        if not tasks:
            LOG.error("COLLECTOR=%r started no collectors", COLLECTOR)
            return

        await _run_until_signal(tasks)
    finally:
        await pool.close()


async def _run_until_signal(tasks: list[asyncio.Task]) -> None:
    """Run the collector tasks until SIGTERM/SIGINT, then cancel them and wait
    for their cleanup before returning.

    Docker sends every container SIGTERM on `docker compose up -d` (a routine
    part of every deploy, not just a crash). Python's default disposition for
    an unhandled SIGTERM terminates the process immediately - `finally` blocks
    do not run - so without this, the meter collector's MQTT session is never
    closed server-side before the replacement container opens a new one,
    which is the most direct way to violate the "only one Anker MQTT session"
    limit on every single release.
    """
    loop = asyncio.get_running_loop()
    stop = loop.create_future()

    def _request_stop(sig: signal.Signals) -> None:
        if not stop.done():
            LOG.info("Received %s - shutting down", sig.name)
            stop.set_result(None)

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _request_stop, sig)

    run_task = asyncio.gather(*tasks)
    await asyncio.wait({run_task, stop}, return_when=asyncio.FIRST_COMPLETED)

    # Either a signal arrived, or one task ended on its own - each retries
    # internally, so the latter "should not normally happen", but either way
    # cancel whatever is still running and wait for every task's cleanup
    # (closing its MQTT/Modbus/Speedwire session) before returning, rather
    # than leaving healthy tasks orphaned when the process exits.
    for t in tasks:
        if not t.done():
            t.cancel()
    results = await asyncio.gather(*tasks, return_exceptions=True)
    for r in results:
        if isinstance(r, Exception) and not isinstance(r, asyncio.CancelledError):
            LOG.error("Collector task ended unexpectedly: %s", r)

    # run_task (the original gather) must still be retrieved once itself, or
    # asyncio logs its own aggregated exception as leaked - the exception it
    # carries is already covered by the per-task loop above.
    if run_task.done():
        with contextlib.suppress(Exception):
            run_task.exception()


if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
