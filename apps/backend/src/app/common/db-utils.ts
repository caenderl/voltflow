import type { DataRange } from '@org/shared-types';

/**
 * Cap on rows returned by an unaggregated ("raw" resolution) time-series
 * query. Without it, a wide from/to span against a low poll interval can pull
 * well over a million rows into one JSON response - a real OOM risk on the
 * 256 MB backend container this app is often deployed on (Raspberry Pi).
 * Generous relative to real usage: a full day of 5s-interval meter readings
 * is ~17k rows.
 */
export const MAX_RAW_ROWS = 50_000;

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
