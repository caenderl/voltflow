import { BadRequestException } from '@nestjs/common';

const ONE_HOUR_MS = 60 * 60 * 1000;

/** Default `from` when the query omits it: one hour before `to`. */
export const lastHour = (to: Date): Date => new Date(to.getTime() - ONE_HOUR_MS);

/** Default `from` for month-scoped endpoints: first day of `to`'s month. */
export const startOfMonth = (to: Date): Date =>
  new Date(to.getFullYear(), to.getMonth(), 1);

/**
 * Parse `from`/`to` query params into a [from, to) range.
 * `to` defaults to now, `from` to `defaultFrom(to)`.
 */
export function parseRange(
  fromStr?: string,
  toStr?: string,
  defaultFrom: (to: Date) => Date = lastHour,
): { from: Date; to: Date } {
  const to = toStr ? new Date(toStr) : new Date();
  const from = fromStr ? new Date(fromStr) : defaultFrom(to);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    throw new BadRequestException('Invalid from/to timestamp.');
  }
  return { from, to };
}

/** Parse an integer within [min, max]; empty/undefined -> fallback. */
export function parseIntInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new BadRequestException(`${field} must be an integer in [${min}, ${max}]`);
  }
  return n;
}

/** Trimmed string, or null for empty/undefined input. */
export function emptyToNull(value: unknown): string | null {
  return value === undefined || value === null || value === ''
    ? null
    : String(value).trim();
}

/** How to parse one field of a config request body. */
export type ConfigFieldSpec =
  | { kind: 'bool' }
  | { kind: 'string' }
  | { kind: 'int'; min: number; max: number; fallback: number };

/**
 * Parse & validate a config request body against a per-field schema, so each
 * config endpoint declares its fields once instead of hand-writing the same
 * Boolean/emptyToNull/parseIntInRange calls. The field key doubles as the error
 * label. Device-specific cross-field rules (e.g. "host required when enabled")
 * stay in the controller, applied to the returned object.
 */
export function parseConfig<T extends object>(
  body: Partial<Record<keyof T, unknown>>,
  schema: { [K in keyof T]: ConfigFieldSpec },
): T {
  const out = {} as T;
  for (const key of Object.keys(schema) as (keyof T)[]) {
    const spec = schema[key];
    const raw = body[key];
    let value: unknown;
    switch (spec.kind) {
      case 'bool':
        value = Boolean(raw);
        break;
      case 'string':
        value = emptyToNull(raw);
        break;
      case 'int':
        value = parseIntInRange(raw, String(key), spec.min, spec.max, spec.fallback);
        break;
      default: {
        const exhaustive: never = spec;
        throw new Error(`Unhandled ConfigFieldSpec kind: ${JSON.stringify(exhaustive)}`);
      }
    }
    out[key] = value as T[keyof T];
  }
  return out;
}
