import { describe, expect, it } from 'vitest';
import { numOrNull, round2, round3, round4, toDataRange } from './db-utils';

describe('numOrNull', () => {
  it('converts pg numeric strings to numbers', () => {
    expect(numOrNull('42.5')).toBe(42.5);
    expect(numOrNull(7)).toBe(7);
  });

  it('passes null/undefined through as null', () => {
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull(undefined)).toBeNull();
  });
});

describe('round2 / round3 / round4', () => {
  it('rounds to the expected precision', () => {
    expect(round2(1.234)).toBe(1.23);
    expect(round2(1.235)).toBe(1.24);
    expect(round3(1.2344)).toBe(1.234);
    expect(round3(1.2345)).toBe(1.235);
    expect(round4(1.23454)).toBe(1.2345);
    expect(round4(1.23455)).toBe(1.2346);
  });
});

describe('toDataRange', () => {
  it('maps first/last timestamps to ISO strings', () => {
    const range = toDataRange({
      first: '2026-01-01T00:00:00Z',
      last: '2026-05-20T10:00:00Z',
    });
    expect(range.first).toBe('2026-01-01T00:00:00.000Z');
    expect(range.last).toBe('2026-05-20T10:00:00.000Z');
  });

  it('handles empty tables (null min/max) and missing rows', () => {
    expect(toDataRange({ first: null, last: null })).toEqual({ first: null, last: null });
    expect(toDataRange(undefined)).toEqual({ first: null, last: null });
  });
});
