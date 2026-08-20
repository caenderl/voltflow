import { BadRequestException } from '@nestjs/common';
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

/**
 * Reject a raw query that hit {@link MAX_RAW_ROWS} instead of returning the
 * truncated head of the series.
 *
 * A silently shortened series is indistinguishable from a collector outage:
 * the chart simply stops part-way and reads as missing data. This app treats a
 * gap as a statement about the devices ("unreachable" is a gap, never a
 * fabricated 0), so the API must not invent one. Queried with `LIMIT max + 1`
 * so hitting the cap is detectable without counting the whole range.
 */
export function assertNotTruncated(rowCount: number, what: string): void {
  if (rowCount > MAX_RAW_ROWS) {
    throw new BadRequestException(
      `${what}: range too large for raw resolution (over ${MAX_RAW_ROWS} readings). ` +
        `Narrow from/to, or use an aggregated resolution.`,
    );
  }
}

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
