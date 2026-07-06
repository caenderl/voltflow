import { describe, expect, it } from 'vitest';
import {
  appendWindowed,
  energySlots,
  fiveMinuteSlots,
  isoToSlotKey,
  liveSparkChart,
  netWatts,
  round2,
  signedPowerChart,
  slotKey,
  sumByFiveMinKey,
} from './chart-utils';

describe('isoToSlotKey', () => {
  it('converts ISO date to the 0-indexed-month slot key', () => {
    expect(isoToSlotKey('2026-05-25')).toBe('2026-4-25');
    expect(isoToSlotKey('2026-01-01')).toBe('2026-0-1');
  });
});

describe('netWatts', () => {
  it('is grid minus pv, treating null as 0', () => {
    expect(netWatts(500, 200)).toBe(300);
    expect(netWatts(null, 200)).toBe(-200);
    expect(netWatts(500, null)).toBe(500);
    expect(netWatts(null, null)).toBe(0);
  });
});

describe('round2', () => {
  it('rounds to two decimals', () => {
    expect(round2(1.005 + 0.001)).toBe(1.01);
    expect(round2(2.4449)).toBe(2.44);
    expect(round2(-1.555)).toBe(-1.55); // Math.round rounds -155.5 up to -155
  });
});

describe('slotKey', () => {
  it('day view: hour of day', () => {
    expect(slotKey('day', new Date(2026, 4, 20, 14, 30).getTime())).toBe('14');
  });

  it('week/month view: local date key with 0-indexed month', () => {
    const ms = new Date(2026, 4, 20, 14, 30).getTime();
    expect(slotKey('week', ms)).toBe('2026-4-20');
    expect(slotKey('month', ms)).toBe('2026-4-20');
  });

  it('matches isoToSlotKey for the same day', () => {
    const ms = new Date(2026, 4, 25, 9).getTime();
    expect(slotKey('week', ms)).toBe(isoToSlotKey('2026-05-25'));
  });
});

describe('energySlots', () => {
  const ref = new Date(2026, 4, 20); // Wed 2026-05-20

  it('day view: 24 hour slots keyed 0..23', () => {
    const slots = energySlots('day', ref);
    expect(slots).toHaveLength(24);
    expect(slots[0].key).toBe('0');
    expect(slots[23].key).toBe('23');
  });

  it('week view: 7 day slots starting Monday', () => {
    const slots = energySlots('week', ref);
    expect(slots).toHaveLength(7);
    expect(slots[0].key).toBe('2026-4-18'); // Mon 2026-05-18
    expect(slots[6].key).toBe('2026-4-24'); // Sun 2026-05-24
  });

  it('month view: one slot per calendar day (incl. leap February)', () => {
    expect(energySlots('month', new Date(2026, 4, 20))).toHaveLength(31);
    expect(energySlots('month', new Date(2028, 1, 10))).toHaveLength(29);
    expect(energySlots('month', new Date(2026, 1, 10))).toHaveLength(28);
  });
});

describe('fiveMinuteSlots', () => {
  it('288 five-minute-of-day slots, keyed 0..287, HH:MM labels', () => {
    const slots = fiveMinuteSlots(new Date(2026, 4, 20));
    expect(slots).toHaveLength((24 * 60) / 5);
    expect(slots[0].key).toBe('0');
    expect(slots[287].key).toBe('287');
    expect(slots[18].label).toBe('01:30'); // 18 * 5 min = 90 min
  });
});

describe('sumByFiveMinKey', () => {
  it('keys rows by local 5-minute bucket of day, summing on collision', () => {
    const rows = [
      { time: new Date(2026, 4, 20, 14, 2).toISOString(), yieldKwh: 0.02 },
      { time: new Date(2026, 4, 20, 14, 4).toISOString(), yieldKwh: 0.01 }, // same bucket as 14:02
      { time: new Date(2026, 4, 20, 14, 6).toISOString(), yieldKwh: 0.03 },
    ];
    const byKey = sumByFiveMinKey(rows, (r) => r.yieldKwh);
    // 14:00-14:05 -> bucket floor(845/5)=169; 14:05-14:10 -> bucket 170
    expect(byKey.get(String(Math.floor((14 * 60 + 2) / 5)))).toBeCloseTo(0.03);
    expect(byKey.get(String(Math.floor((14 * 60 + 6) / 5)))).toBeCloseTo(0.03);
  });
});

describe('appendWindowed', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 4, 20, 10, min)).toISOString();
  const windowMs = 10 * 60 * 1000;

  it('merges, sorts and de-dupes by timestamp (newer point wins)', () => {
    const existing = [
      { time: at(2), v: 'a' },
      { time: at(4), v: 'b' },
    ];
    const incoming = [
      { time: at(3), v: 'c' },
      { time: at(4), v: 'B' }, // same timestamp -> replaces 'b'
    ];
    const out = appendWindowed(existing, incoming, windowMs);
    expect(out.map((p) => p.v)).toEqual(['a', 'c', 'B']);
  });

  it('trims points older than the window relative to the newest point', () => {
    const existing = [{ time: at(0), v: 'old' }];
    const incoming = [{ time: at(15), v: 'new' }]; // 15 min later > 10 min window
    const out = appendWindowed(existing, incoming, windowMs);
    expect(out.map((p) => p.v)).toEqual(['new']);
  });
});

type LineSeries = { data: [string, number | null][] }[];

describe('signedPowerChart', () => {
  const data: [string, number][] = [
    ['2026-05-20T10:00:00Z', 500],
    ['2026-05-20T10:01:00Z', -300],
    ['2026-05-20T10:02:00Z', 200],
  ];

  it('clamps instead of null-splitting: both series stay continuous', () => {
    const opt = signedPowerChart(data);
    const [imp, exp] = opt.series as LineSeries;
    expect(imp.data.map(([, v]) => v)).toEqual([500, 0, 200]);
    expect(exp.data.map(([, v]) => v)).toEqual([0, -300, 0]);
  });
});

describe('liveSparkChart', () => {
  const data: [string, number][] = [
    ['2026-05-20T10:00:00Z', 500],
    ['2026-05-20T10:01:00Z', -300],
  ];

  it('splits by sign with nulls (import >= 0, export < 0)', () => {
    const opt = liveSparkChart(data);
    const [imp, exp] = opt.series as LineSeries;
    expect(imp.data.map(([, v]) => v)).toEqual([500, null]);
    expect(exp.data.map(([, v]) => v)).toEqual([null, -300]);
  });

  it('pins the time axis to the given window', () => {
    const opt = liveSparkChart(data, { min: 'A', max: 'B' });
    const xAxis = opt.xAxis as { min?: string; max?: string };
    expect(xAxis.min).toBe('A');
    expect(xAxis.max).toBe('B');
  });
});
