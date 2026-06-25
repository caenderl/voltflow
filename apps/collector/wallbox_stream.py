"""
wallbox_stream.py - Reusable Modbus TCP connection to the Anker SOLIX V1
Smart EV Charger (A5191).

Provides `stream_wallbox()`: an async generator that yields a snapshot of the
live values every `interval` seconds. Used by the collector (collector.py).

Register map (verified against the device, official spec V1.0.0):
  - Measurements live on INPUT registers (FC4) from address 20000.
  - Strings are big-endian (2 ASCII bytes per register), UINT32 = high word
    first. Gain is a divisor (voltage /10, current /100).
"""

import asyncio
import logging
from collections.abc import AsyncIterator

from pymodbus.client import AsyncModbusTcpClient

LOG = logging.getLogger("voltflow.wallbox")

# Identity registers (read once, for device registration)
_REG_MODEL = (20001, 10)   # STRING
_REG_SERIAL = (20011, 12)  # STRING

# Live data block: a single contiguous FC4 read covers 20053..20097.
_BLOCK_BASE = 20053
_BLOCK_COUNT = 45  # 20053 .. 20097 inclusive

# Offsets within the block (address - _BLOCK_BASE)
_OFF = {
    "l1_voltage_v": 0,    # 20053, gain 10
    "l2_voltage_v": 1,    # 20054
    "l3_voltage_v": 2,    # 20055
    "l1_current_a": 6,    # 20059, gain 100
    "l2_current_a": 7,    # 20060
    "l3_current_a": 8,    # 20061
    "active_power_w": 15,     # 20068, UINT32 (W)
    "session_duration_s": 29,  # 20082, UINT32 (s)
    "session_energy_wh": 31,   # 20084, UINT32 (Wh)
    "cp_signal": 39,      # 20092
    "status": 44,         # 20097
}


def _u32(regs: list[int], off: int) -> int:
    """Combine two registers (high word first) into a UINT32."""
    return (regs[off] << 16) | regs[off + 1]


def _decode_string(regs: list[int]) -> str:
    raw = b"".join(r.to_bytes(2, "big") for r in regs)
    return raw.split(b"\x00", 1)[0].decode("ascii", "replace").strip()


def _decode_block(regs: list[int]) -> dict:
    return {
        "l1_voltage_v": regs[_OFF["l1_voltage_v"]] / 10,
        "l2_voltage_v": regs[_OFF["l2_voltage_v"]] / 10,
        "l3_voltage_v": regs[_OFF["l3_voltage_v"]] / 10,
        "l1_current_a": regs[_OFF["l1_current_a"]] / 100,
        "l2_current_a": regs[_OFF["l2_current_a"]] / 100,
        "l3_current_a": regs[_OFF["l3_current_a"]] / 100,
        "active_power_w": float(_u32(regs, _OFF["active_power_w"])),
        "session_duration_s": float(_u32(regs, _OFF["session_duration_s"])),
        "session_energy_wh": float(_u32(regs, _OFF["session_energy_wh"])),
        "cp_signal": regs[_OFF["cp_signal"]],
        "status": regs[_OFF["status"]],
    }


async def _read_input(client: AsyncModbusTcpClient, address: int, count: int, unit_id: int) -> list[int]:
    rr = await client.read_input_registers(address=address, count=count, device_id=unit_id)
    if rr.isError():
        raise RuntimeError(f"Modbus read error at {address}: {rr}")
    return rr.registers


async def stream_wallbox(
    host: str,
    port: int = 502,
    unit_id: int = 1,
    interval: int = 30,
) -> AsyncIterator[dict]:
    """Async generator yielding wallbox snapshots every `interval` seconds.

    Raises on connection / read errors so the caller can reconnect.

    Yields:
        dict with device_sn, device_pn and the live measurement fields.
    """
    client = AsyncModbusTcpClient(host, port=port)
    await client.connect()
    if not client.connected:
        raise RuntimeError(f"Modbus connection to {host}:{port} failed")
    try:
        model = _decode_string(await _read_input(client, *_REG_MODEL, unit_id))
        serial = _decode_string(await _read_input(client, *_REG_SERIAL, unit_id))
        if not serial:
            raise RuntimeError("Wallbox returned empty serial number")
        LOG.info("Wallbox connected: %s (%s) at %s:%s", model, serial, host, port)

        while True:
            regs = await _read_input(client, _BLOCK_BASE, _BLOCK_COUNT, unit_id)
            snap = _decode_block(regs)
            snap["device_sn"] = serial
            snap["device_pn"] = model
            yield snap
            await asyncio.sleep(interval)
    finally:
        client.close()
