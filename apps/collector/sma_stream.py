"""
sma_stream.py - Reusable Speedwire connection to an SMA PV inverter
(STP 6000TL-20) via pysma-plus.

Provides `stream_sma()`: an async generator that yields a snapshot of the live
values every `interval` seconds. Used by the collector (collector.py).

Lifecycle: one persistent aiohttp.ClientSession + device session (new_session /
close_session) is held for the whole stream, NOT rebuilt per poll.

Night behaviour: after sunset the inverter sleeps. That shows up in two shapes -
reads that fail outright, and reads that still succeed but carry only the energy
counters (no production fields). Both are handled the same way: a failed read is
first retried a few times, and only after several consecutive failed cycles is an
`asleep` snapshot (0 W) yielded, so the caller neither reconnect-spams nor
records a real daytime read glitch as 0 W. Isolated failures while producing are
skipped (no row yielded) instead. Only a failure to establish the session at all
raises (caller reconnects). The daily_yield carry-over is handled by the caller
(collector._run_sma).

A total loss of contact that starts out of *real production* is never written as
0 W at all (see `sleep_implausible`): the inverter ramps down to near-0 W before
it sleeps, so that is a Speedwire/pysma fault, and such cycles yield no row - a
gap in the chart rather than a false zero spike.
"""

import asyncio
import logging
from collections.abc import AsyncIterator

from aiohttp import ClientSession
import pysmaplus as smaplus

LOG = logging.getLogger("voltflow.sma")

# pysma-plus sensor .name -> snapshot field (units already match the DB columns)
_FIELD_MAP = {
    "grid_power": "grid_power",
    "pv_power_a": "pv_power_a",
    "pv_power_b": "pv_power_b",
    "daily_yield": "daily_yield_wh",     # Wh
    "total_yield": "total_yield_kwh",    # kWh
    "power_l1": "power_l1",
    "power_l2": "power_l2",
    "power_l3": "power_l3",
    "pv_voltage_a": "pv_voltage_a",
    "pv_voltage_b": "pv_voltage_b",
    "pv_current_a": "pv_current_a",
    "pv_current_b": "pv_current_b",
    "voltage_l1": "voltage_l1",
    "voltage_l2": "voltage_l2",
    "voltage_l3": "voltage_l3",
    "frequency": "frequency",
    "temp_a": "temp_a",
    "status": "status",
}

# Power fields zeroed out in an asleep snapshot.
_POWER_FIELDS = (
    "grid_power", "pv_power_a", "pv_power_b", "power_l1", "power_l2", "power_l3",
)

# Checked to decide "no production reading at all". Must be ALL of these, not
# just grid_power - a single dropped Speedwire UDP read can leave grid_power
# missing on an otherwise-normal read where pv_power_a/b came through fine,
# which is a lossy read, not the inverter actually asleep.
#
# Public because collector._apply_daily_carry gates the daily_yield carry on
# the same definition of "did it produce?". Two copies would silently drift the
# moment a field is added here, which is exactly the bug that gate was written
# to close.
PRODUCTION_FIELDS = ("grid_power", "pv_power_a", "pv_power_b")

# A failed read is retried this many times (immediately) before it counts as a
# failed cycle - most Speedwire read losses are transient and recover at once.
READ_RETRIES = 2
RETRY_DELAY = 2.0        # seconds between immediate retries

# Only after this many consecutive failed cycles is the inverter declared asleep
# (0 W written). Below the threshold a failed cycle yields nothing (no row), so a
# daytime read glitch can neither zero out the live value nor drag the minute
# averages down. At night, sustained failures cross the threshold as normal.
ASLEEP_AFTER = 3

# A run of reads that SUCCEED (ok=True) but carry no production data - only e.g.
# total_yield - has two very different causes, and they are told apart by whether
# total_yield still MOVES (see `_yield_advanced`):
#
#   moving  -> a stale, long-held Speedwire session gone half-dead (observed
#              after the inverter's overnight sleep: total_yield keeps updating
#              while grid_power/pv/daily_yield stop arriving). Rebuild the
#              session after this many reads so daytime reads recover on their
#              own instead of the whole day reading as "asleep".
#   steady  -> the inverter is simply idle: it answers, but generates nothing, so
#              its lifetime counter cannot advance. This is dusk/night on this
#              device (it does NOT always time out). Recycling here would loop
#              all night - ~490 reconnects - and, since the caller records
#              nothing on a recycle, suppress the asleep rows entirely. So fall
#              through to the normal ASLEEP_AFTER path instead.
PARTIAL_RECONNECT = 3

# total_yield is a lifetime kWh counter reported to 3 decimals, so 1 Wh is its
# resolution: anything above that is real generation, anything at or below it is
# the counter standing still.
YIELD_STEADY_EPSILON_KWH = 0.001

# Above this the inverter is unmistakably generating, so it cannot be about to
# fall asleep: it ramps down to single-digit watts first. Losing contact from
# above this level is a comms fault, and 0 W would be a lie.
PRODUCING_ABOVE_W = 100.0

# ...but only for so long. After this many consecutive failed cycles a run that
# began mid-production is accepted as a genuine outage/sleep and asleep rows
# resume, so a failure that starts in daylight and lasts into the night settles
# into 0 W instead of gapping forever. ~10 min at the default 20 s interval;
# observed pysma dropouts recover well inside it.
ASLEEP_GRACE_CYCLES = 30


class SmaSessionStale(RuntimeError):
    """Deliberate session recycle - the inverter is reachable, not asleep.

    Raised when reads keep succeeding without production fields *while
    total_yield still rises* (see PARTIAL_RECONNECT) - the inverter is plainly
    generating, so the session is losing those fields. The caller must reconnect
    *without* recording an asleep row: this is a healthy recovery, not an outage.

    An idle inverter produces the same production-less reads but a steady
    total_yield, and is deliberately NOT raised for: it settles into asleep rows
    via the normal ASLEEP_AFTER path.
    """


def sleep_implausible(last_power: float | None, failed_cycles: int) -> bool:
    """True while a run of failed reads is more likely a comms fault than sleep.

    `last_power` is grid_power from the last successful read. The inverter ramps
    down to near-0 W before it sleeps at dusk, so a total loss of contact
    straight out of real production is a Speedwire/pysma failure - writing 0 W
    there is what puts false zero spikes into an otherwise sunny chart. Such a
    cycle records nothing (a gap) instead. Bounded by ASLEEP_GRACE_CYCLES so a
    real outage starting mid-production still settles into asleep rows.

    Shared with collector._run_sma so the reconnect path applies the same rule.
    """
    if last_power is None or last_power <= PRODUCING_ABOVE_W:
        return False
    return failed_cycles <= ASLEEP_GRACE_CYCLES


def _num(value) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _asleep_snapshot() -> dict:
    """Inverter is sleeping: power fields 0, energy/diagnostics left to carry."""
    snap: dict = {f: 0.0 for f in _POWER_FIELDS}
    snap["asleep"] = True
    # daily_yield_wh / total_yield_kwh stay absent -> carried by the caller.
    return snap


async def _attempt_read(device, sensors) -> dict | None:
    """One raw read attempt.

    Returns None on a hard failure (timeout / OSError / empty read). Otherwise a
    parsed values dict, which may still have all production fields None (a lossy
    read). The awake/asleep decision is made across attempts and cycles by the
    caller - a single attempt is never enough to declare the inverter asleep.
    """
    try:
        ok = await device.read(sensors)
    except (asyncio.TimeoutError, OSError):
        return None
    if not ok:
        return None

    values: dict = {}
    for s in sensors:
        field = _FIELD_MAP.get(s.name)
        if field is not None:
            values[field] = _num(s.value)
    return values


def _has_production(values: dict | None) -> bool:
    """True if the read carries at least one real production value.

    A failed/lossy read (None, or all production fields None) is NOT production;
    it must not be recorded as 0 W while the inverter may still be awake.
    """
    if values is None:
        return False
    return any(values.get(f) is not None for f in PRODUCTION_FIELDS)


def _yield_advanced(base: float | None, current: float | None) -> bool:
    """True if total_yield has climbed since a production-less run began.

    The discriminator between a half-dead session and an idle inverter: only a
    generating inverter can raise its lifetime counter, so a counter that keeps
    moving while the production fields stay missing means the session is dropping
    those fields (recycle it), whereas a counter standing still means there is
    genuinely nothing to report (let it settle into asleep rows).

    Unknown on either side -> False: without evidence of movement, prefer the
    quiet path over recycling the session.
    """
    if base is None or current is None:
        return False
    return current - base > YIELD_STEADY_EPSILON_KWH


def _finalize_awake(values: dict) -> dict:
    """Mark a good read as an awake snapshot (status float -> int)."""
    values["asleep"] = False
    if values.get("status") is not None:
        values["status"] = int(values["status"])
    return values


async def stream_sma(
    host: str,
    password: str,
    interval: int = 60,
) -> AsyncIterator[dict]:
    """Async generator yielding SMA snapshots every `interval` seconds.

    Raises on failure to establish the session (caller reconnects), and
    SmaSessionStale when the session must be recycled while the inverter is
    still reachable *and demonstrably generating* (total_yield rising without
    production fields). Failed reads during an established session are retried,
    then skipped, and only yield an asleep snapshot (0 W) after ASLEEP_AFTER
    consecutive failed cycles - and never at all while contact was lost out of
    real production (see `sleep_implausible`).

    Yields:
        dict with device_sn, device_pn and the live measurement fields. A cycle
        yields nothing when a read failure is skipped or gapped.
    """
    session = ClientSession()
    device = None
    try:
        device = smaplus.getDevice(
            session, host, password=password, groupuser="user", accessmethod="speedwireinv"
        )
        if device is None:
            raise RuntimeError(f"SMA getDevice returned None for {host}")
        if not await device.new_session():
            raise RuntimeError(f"SMA session/auth failed for {host}")

        info = await device.device_info()
        serial = str(info.get("serial") or info.get("id") or "")
        model = info.get("name")
        if not serial:
            raise RuntimeError("SMA returned empty serial number")
        LOG.info("SMA connected: %s (%s) at %s", model, serial, host)

        sensors = await device.get_sensors()
        consecutive_fail = 0
        partial_streak = 0
        partial_base_yield: float | None = None  # total_yield when the run began
        last_power: float | None = None   # grid_power of the last good read
        gapping = False                   # logged once per gap run
        idling = False                    # logged once per idle run
        while True:
            # Retry a failed read a few times before believing it: a single
            # dropped Speedwire read while the inverter is producing must not be
            # recorded as 0 W. Once already declared asleep (night), one attempt
            # per cycle is enough - no point retrying into a dark inverter.
            retries = READ_RETRIES if consecutive_fail < ASLEEP_AFTER else 0
            values: dict | None = None
            for attempt in range(1 + retries):
                values = await _attempt_read(device, sensors)
                if _has_production(values):
                    break
                if attempt < retries:
                    await asyncio.sleep(RETRY_DELAY)

            if _has_production(values):
                consecutive_fail = 0
                partial_streak = 0
                partial_base_yield = None
                gapping = False
                idling = False
                # Only overwrite when grid_power itself came through: a read
                # carrying pv_power but no grid_power is still production, so
                # the previous level is a better guess than "unknown".
                if values.get("grid_power") is not None:  # type: ignore[union-attr]
                    last_power = values["grid_power"]     # type: ignore[index]
                snap = _finalize_awake(values)  # type: ignore[arg-type]
            else:
                consecutive_fail += 1
                # A successful read carrying data but no production fields is
                # either a half-dead session or an idle inverter - recycle only
                # the former, or the idle case loops all night and its asleep
                # rows are never written (see PARTIAL_RECONNECT).
                if values is not None:
                    partial_streak += 1
                    total_yield = values.get("total_yield_kwh")
                    if partial_base_yield is None:
                        partial_base_yield = total_yield
                    if partial_streak >= PARTIAL_RECONNECT:
                        if _yield_advanced(partial_base_yield, total_yield):
                            LOG.warning(
                                "SMA session stale: %d reads with data but no "
                                "production fields while total_yield rose "
                                "%.3f -> %.3f kWh - reconnecting",
                                partial_streak, partial_base_yield, total_yield)
                            raise SmaSessionStale(
                                f"stale session after {partial_streak} partial reads")
                        if not idling:
                            LOG.info(
                                "SMA idle: answering but reporting no production, "
                                "total_yield steady at %s kWh - recording asleep "
                                "rows instead of recycling the session",
                                total_yield)
                            idling = True
                else:
                    partial_streak = 0
                    partial_base_yield = None
                if consecutive_fail < ASLEEP_AFTER:
                    # Transient blip while (probably) awake: skip this cycle
                    # rather than writing a false 0 W row.
                    LOG.debug("SMA read blip %d/%d - skipping cycle",
                              consecutive_fail, ASLEEP_AFTER)
                    await asyncio.sleep(interval)
                    continue
                if sleep_implausible(last_power, consecutive_fail):
                    # Contact lost straight out of real production - a comms
                    # fault, not dusk. Record nothing (gap) instead of 0 W.
                    if not gapping:
                        LOG.warning(
                            "SMA unreachable while producing (last %.0f W) - "
                            "recording a gap, not 0 W", last_power)
                        gapping = True
                    await asyncio.sleep(interval)
                    continue
                # Sustained failure -> genuine sleep/outage: yield 0 W, keeping
                # any energy counter that did come through on the last attempt.
                gapping = False
                last_power = 0.0
                snap = _asleep_snapshot()
                if values is not None:
                    for k in ("daily_yield_wh", "total_yield_kwh"):
                        if values.get(k) is not None:
                            snap[k] = values[k]

            snap["device_sn"] = serial
            snap["device_pn"] = model
            yield snap
            await asyncio.sleep(interval)
    finally:
        if device is not None:
            try:
                await device.close_session()
            except Exception:  # noqa: BLE001
                pass
        await session.close()
