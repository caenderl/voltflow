#!/usr/bin/env python3
"""Local Modbus TCP debugger for the Anker SOLIX V1 wallbox (A5191).

Standalone: pure stdlib (socket/struct), no pymodbus, no venv, no DB. Runs
alongside the production collector without disturbing it — the wallbox serves
several Modbus clients concurrently.

Why this exists: the wallbox answers *no* ICMP at all, so `ping` reports 100%
packet loss even when the device is perfectly healthy. Liveness must be tested
on TCP/502 instead. It also runs a Modbus watchdog (holding register 21003,
"Set Timeout", in seconds): if no Modbus request arrives within that window it
switches Modbus off and has to be re-enabled by hand in the Anker app.

Usage:
    scripts/wallbox-debug.py                 # one-shot diagnosis
    scripts/wallbox-debug.py --watch         # monitor, logs every state change
    scripts/wallbox-debug.py --watch --interval 10 --log /tmp/wb.log
    scripts/wallbox-debug.py --watchdog-test # confirm the auto-disable (see below)
"""

from __future__ import annotations

import argparse
import socket
import struct
import subprocess
import sys
import time
from datetime import datetime, timedelta

HOST = "192.168.0.206"
PORT = 502
UNIT = 1

# --- Register map (see apps/collector/docs/…modbus-protocol-v1.0.0.pdf) -------
REG_MODEL = (20001, 10)   # STRING
REG_SERIAL = (20011, 12)  # STRING
BLOCK_BASE, BLOCK_COUNT = 20053, 45

CONTROL = {  # FC3 holding registers
    21000: ("Charging Command", {0: "idle/none", 1: "start", 2: "stop"}, 1),
    21001: ("Max Current Setting", None, 10),
    21002: ("Boost Mode", {0: "off", 1: "on"}, 1),
    21003: ("Set Timeout (Modbus watchdog)", None, 1),
    21004: ("reserved", None, 1),
    21005: ("Charging Phases", {0: "auto", 1: "single", 2: "three"}, 1),
}

CHARGING_STATUS = {
    0: "Idle", 1: "Preparing", 2: "Charging", 3: "Charger Paused",
    4: "Vehicle Paused", 5: "Charging Completed", 6: "Reserving",
    7: "Disabled", 8: "Error",
}
CP_SIGNAL = {
    0: "A (12V, kein Fahrzeug)", 3: "B1 (9V)", 4: "B2 (9V)", 5: "C1 (6V)",
    6: "C2 (6V, lädt)", 7: "Error", 8: "D1 (3V)", 9: "D2 (3V)",
    10: "E (0V)", 11: "F (-12V)",
}


class ModbusError(RuntimeError):
    """Device answered, but with a Modbus exception."""


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def read_regs(fc: int, addr: int, count: int, timeout: float = 5.0) -> list[int]:
    """One request per connection — mirrors how a fresh collector connect behaves.

    Raises OSError subclasses for transport problems, ModbusError for exceptions.
    """
    s = socket.socket()
    s.settimeout(timeout)
    try:
        s.connect((HOST, PORT))
        pdu = struct.pack(">BHH", fc, addr, count)
        s.sendall(struct.pack(">HHHB", 1, 0, len(pdu) + 1, UNIT) + pdu)
        head = s.recv(9)
        if len(head) < 9:
            raise ModbusError("kurze/leere Antwort (Verbindung abgebrochen)")
        if head[7] & 0x80:
            raise ModbusError(f"Modbus exception code {head[8]} (fc={head[7] & 0x7f})")
        want = head[8]
        body = b""
        while len(body) < want:
            chunk = s.recv(want - len(body))
            if not chunk:
                raise ModbusError("Antwort unvollständig")
            body += chunk
        return list(struct.unpack(">" + "H" * (len(body) // 2), body))
    finally:
        s.close()


def decode_string(regs: list[int]) -> str:
    raw = b"".join(r.to_bytes(2, "big") for r in regs)
    return raw.split(b"\x00", 1)[0].decode("ascii", "replace").strip()


def u32(regs: list[int], off: int) -> int:
    return (regs[off] << 16) | regs[off + 1]


def classify(err: Exception) -> tuple[str, str]:
    """Map an exception to (short_state, human explanation)."""
    if isinstance(err, ConnectionRefusedError):
        return "PORT-ZU", ("TCP RST auf :502 — Gerät lebt, aber Modbus ist AUS. "
                           "Typisch nach Watchdog-Timeout; in der Anker-App wieder einschalten.")
    if isinstance(err, socket.timeout):
        return "TIMEOUT", ("Keine TCP-Antwort — Gerät nicht im Netz, anderes IP, "
                           "oder Funkstrecke weg. ARP-Status siehe unten.")
    if isinstance(err, ModbusError):
        return "MB-FEHLER", str(err)
    if isinstance(err, OSError):
        return "NETZ", f"{type(err).__name__}: {err}"
    return "FEHLER", f"{type(err).__name__}: {err}"


def arp_state() -> str:
    try:
        out = subprocess.run(["arp", "-n", HOST], capture_output=True, text=True, timeout=5).stdout.strip()
        return out or "kein ARP-Eintrag"
    except Exception as err:  # noqa: BLE001 - diagnostics must never crash
        return f"arp nicht abfragbar ({err})"


def icmp_state() -> str:
    """Ping for reference only — this device never answers, healthy or not."""
    try:
        r = subprocess.run(["ping", "-c", "2", "-W", "1000", HOST],
                           capture_output=True, text=True, timeout=10)
        return "antwortet" if r.returncode == 0 else "keine Antwort (bei der A5191 NORMAL)"
    except Exception as err:  # noqa: BLE001
        return f"nicht ausführbar ({err})"


def diagnose() -> int:
    print(f"=== Wallbox-Diagnose {HOST}:{PORT} unit={UNIT} — {_now()} ===\n")

    t0 = time.time()
    try:
        model = decode_string(read_regs(4, *REG_MODEL))
        serial = decode_string(read_regs(4, *REG_SERIAL))
    except Exception as err:  # noqa: BLE001
        state, why = classify(err)
        print(f"NICHT ERREICHBAR  [{state}]  nach {time.time() - t0:.2f}s")
        print(f"  {why}\n")
        print(f"  ARP : {arp_state()}")
        print(f"  Ping: {icmp_state()}")
        return 1

    print(f"erreichbar in {time.time() - t0:.2f}s")
    print(f"  Modell {model}   Seriennummer {serial}\n")

    regs = read_regs(4, BLOCK_BASE, BLOCK_COUNT)
    status = regs[44]
    cp = regs[39]
    print("--- Messwerte (FC4 20053+) ---")
    print(f"  Spannung L1/L2/L3 : {regs[0]/10:.1f} / {regs[1]/10:.1f} / {regs[2]/10:.1f} V")
    print(f"  Strom    L1/L2/L3 : {regs[6]/100:.2f} / {regs[7]/100:.2f} / {regs[8]/100:.2f} A")
    print(f"  Ladeleistung      : {u32(regs, 15)} W")
    print(f"  Session           : {u32(regs, 29)} s / {u32(regs, 31)} Wh")
    print(f"  Ladestatus  (20097): {status} = {CHARGING_STATUS.get(status, '?')}")
    print(f"  CP-Signal   (20092): {cp} = {CP_SIGNAL.get(cp, '?')}\n")

    print("--- Steuerregister (FC3 21000+) ---")
    ctrl = read_regs(3, 21000, 6)
    for i, val in enumerate(ctrl):
        addr = 21000 + i
        name, mapping, gain = CONTROL.get(addr, (f"reg {addr}", None, 1))
        shown = val / gain if gain != 1 else val
        extra = f" = {mapping[val]}" if mapping and val in mapping else ""
        print(f"  {addr}  {name:<32} {shown}{extra}")

    timeout_s = ctrl[3]
    print(f"\n--- Watchdog ---")
    print(f"  Register 21003 = {timeout_s}s: kommt {timeout_s}s lang kein Modbus-Request,")
    print(f"  schaltet die Wallbox Modbus ab (Port 502 zu, manuelles Einschalten nötig).")
    print(f"  Collector-Poll-Intervall muss deutlich darunter liegen.")
    print(f"\n  ARP : {arp_state()}")
    print(f"  Ping: {icmp_state()}")
    return 0


def watch(interval: int, logfile: str | None) -> int:
    """Poll forever, print one line per poll, shout on every state change."""
    sink = open(logfile, "a", buffering=1) if logfile else None

    def emit(line: str, always: bool = False) -> None:
        if sink:
            sink.write(line + "\n")
        if always or not sink:
            print(line, flush=True)

    emit(f"# {_now()} monitor gestartet: {HOST}:{PORT} alle {interval}s", always=True)
    last_state: str | None = None
    since = time.time()
    fails = 0

    try:
        while True:
            t0 = time.time()
            try:
                regs = read_regs(4, BLOCK_BASE, BLOCK_COUNT)
                state = "OK"
                detail = (f"{regs[0]/10:.1f}V  {regs[6]/100:.2f}A  "
                          f"{u32(regs, 15)}W  status={regs[44]}({CHARGING_STATUS.get(regs[44], '?')})  "
                          f"{time.time() - t0:.2f}s")
            except Exception as err:  # noqa: BLE001
                state, why = classify(err)
                detail = why
                fails += 1

            if state != last_state:
                dur = timedelta(seconds=int(time.time() - since))
                if last_state is not None:
                    emit(f"{_now()}  >>> WECHSEL {last_state} -> {state}  "
                         f"(vorheriger Zustand hielt {dur})", always=True)
                    if state != "OK":
                        emit(f"{_now()}      ARP: {arp_state()}", always=True)
                emit(f"{_now()}  [{state}] {detail}", always=True)
                last_state, since = state, time.time()
            else:
                emit(f"{_now()}  [{state}] {detail}")

            time.sleep(max(0.0, interval - (time.time() - t0)))
    except KeyboardInterrupt:
        emit(f"# {_now()} monitor beendet ({fails} Fehlversuche)", always=True)
        return 0


def watchdog_test(pause: int) -> int:
    """Deliberately stop polling for `pause`s to prove the auto-disable.

    Costs you a manual Modbus re-enable in the Anker app afterwards — and only
    works if nothing else (i.e. the prod collector) keeps polling in parallel.
    """
    print(f"Vorher: Modbus muss AN sein und der Prod-Collector gestoppt,")
    print(f"sonst hält dessen Polling den Watchdog am Leben.\n")
    try:
        read_regs(4, BLOCK_BASE, 3)
        print(f"{_now()}  Ausgangslage: erreichbar. Pausiere {pause}s ...")
    except Exception as err:  # noqa: BLE001
        print(f"{_now()}  Abbruch — schon jetzt nicht erreichbar: {classify(err)[1]}")
        return 1

    time.sleep(pause)
    try:
        read_regs(4, BLOCK_BASE, 3)
        print(f"{_now()}  nach {pause}s immer noch erreichbar — Watchdog hat NICHT zugeschlagen")
        return 0
    except Exception as err:  # noqa: BLE001
        state, why = classify(err)
        print(f"{_now()}  nach {pause}s: [{state}] {why}")
        print("  -> Watchdog bestätigt. Modbus in der Anker-App wieder einschalten.")
        return 0


def main() -> int:
    global HOST, PORT, UNIT

    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default=HOST)
    p.add_argument("--port", type=int, default=PORT)
    p.add_argument("--unit", type=int, default=UNIT)
    p.add_argument("--watch", action="store_true", help="Dauermonitor statt Einmal-Diagnose")
    p.add_argument("--interval", type=int, default=20, help="Poll-Intervall in s (default 20)")
    p.add_argument("--log", help="zusätzlich in Datei schreiben (nur Zustandswechsel auf stdout)")
    p.add_argument("--watchdog-test", nargs="?", type=int, const=150, metavar="SEK",
                   help="Polling absichtlich SEK Sekunden aussetzen (default 150)")
    args = p.parse_args()

    HOST, PORT, UNIT = args.host, args.port, args.unit

    if args.watchdog_test is not None:
        return watchdog_test(args.watchdog_test)
    if args.watch:
        return watch(args.interval, args.log)
    return diagnose()


if __name__ == "__main__":
    sys.exit(main())
