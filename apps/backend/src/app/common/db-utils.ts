import type { DataRange } from '@org/shared-types';

/** Numeric DB value (pg returns numerics as strings), or null. */
export function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

/** Map a `SELECT min(time) AS first, max(time) AS last` row to a DataRange. */
export function toDataRange(row: Record<string, unknown> | undefined): DataRange {
  const r = row ?? {};
  return {
    first: r['first'] ? new Date(r['first'] as string).toISOString() : null,
    last: r['last'] ? new Date(r['last'] as string).toISOString() : null,
  };
}
