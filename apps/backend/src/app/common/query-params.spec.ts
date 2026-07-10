import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  emptyToNull,
  parseConfig,
  parseIntInRange,
  parseRange,
  startOfMonth,
} from './query-params';

describe('parseRange', () => {
  it('parses explicit from/to', () => {
    const { from, to } = parseRange('2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z');
    expect(from.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-05-02T00:00:00.000Z');
  });

  it('defaults to [now - 1h, now]', () => {
    const before = Date.now();
    const { from, to } = parseRange();
    expect(to.getTime()).toBeGreaterThanOrEqual(before);
    expect(to.getTime() - from.getTime()).toBe(60 * 60 * 1000);
  });

  it('uses a custom defaultFrom relative to to', () => {
    const { from } = parseRange(undefined, '2026-05-20T12:00:00Z', startOfMonth);
    expect(from.getDate()).toBe(1);
    expect(from.getMonth()).toBe(new Date('2026-05-20T12:00:00Z').getMonth());
  });

  it('rejects unparseable timestamps', () => {
    expect(() => parseRange('nope')).toThrow(BadRequestException);
    expect(() => parseRange('2026-05-01', 'nope')).toThrow(BadRequestException);
  });
});

describe('parseIntInRange', () => {
  it('accepts integers within the range', () => {
    expect(parseIntInRange(502, 'port', 1, 65535, 502)).toBe(502);
    expect(parseIntInRange('8080', 'port', 1, 65535, 502)).toBe(8080);
  });

  it('falls back for empty/undefined/null', () => {
    expect(parseIntInRange(undefined, 'port', 1, 65535, 502)).toBe(502);
    expect(parseIntInRange(null, 'port', 1, 65535, 502)).toBe(502);
    expect(parseIntInRange('', 'port', 1, 65535, 502)).toBe(502);
  });

  it('rejects out-of-range and non-integer values', () => {
    expect(() => parseIntInRange(0, 'port', 1, 65535, 502)).toThrow(BadRequestException);
    expect(() => parseIntInRange(70000, 'port', 1, 65535, 502)).toThrow(BadRequestException);
    expect(() => parseIntInRange(1.5, 'port', 1, 65535, 502)).toThrow(BadRequestException);
    expect(() => parseIntInRange('abc', 'port', 1, 65535, 502)).toThrow(BadRequestException);
  });
});

describe('emptyToNull', () => {
  it('maps empty-ish values to null', () => {
    expect(emptyToNull(undefined)).toBeNull();
    expect(emptyToNull(null)).toBeNull();
    expect(emptyToNull('')).toBeNull();
  });

  it('trims non-empty strings', () => {
    expect(emptyToNull('  host.local ')).toBe('host.local');
    // Whitespace-only input is not caught by the empty check -> trimmed to ''.
    expect(emptyToNull('   ')).toBe('');
  });
});

describe('parseConfig', () => {
  interface Cfg {
    enabled: boolean;
    host: string | null;
    port: number;
  }
  const schema = {
    enabled: { kind: 'bool' },
    host: { kind: 'string' },
    port: { kind: 'int', min: 1, max: 65535, fallback: 502 },
  } as const;

  it('coerces each field per its spec', () => {
    const cfg = parseConfig<Cfg>(
      { enabled: 1 as unknown, host: '  h.local ', port: '8080' },
      schema,
    );
    expect(cfg).toEqual({ enabled: true, host: 'h.local', port: 8080 });
  });

  it('applies defaults for missing int / null-ish string / falsy bool', () => {
    const cfg = parseConfig<Cfg>({}, schema);
    expect(cfg).toEqual({ enabled: false, host: null, port: 502 });
  });

  it('throws with the field name as label for an out-of-range int', () => {
    expect(() => parseConfig<Cfg>({ port: 70000 }, schema)).toThrow(
      BadRequestException,
    );
    expect(() => parseConfig<Cfg>({ port: 70000 }, schema)).toThrow('port');
  });

  it('only emits keys present in the schema (ignores extra body fields)', () => {
    const cfg = parseConfig<Cfg>(
      { enabled: true, host: 'h', port: 10, extra: 'x' } as Record<string, unknown>,
      schema,
    );
    expect(Object.keys(cfg).sort()).toEqual(['enabled', 'host', 'port']);
  });
});
