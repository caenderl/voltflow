import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayLabel,
  periodLabelFor,
  rangeFor,
  startOfDay,
  startOfWeek,
  toLocalDateString,
  toLocalTimeString,
} from './date-utils';

// Wed 2026-05-20 14:30 local time
const wednesday = new Date(2026, 4, 20, 14, 30, 0);

describe('toLocalDateString', () => {
  it('formats as YYYY-MM-DD with zero padding', () => {
    expect(toLocalDateString(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toLocalDateString(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('toLocalTimeString', () => {
  it('formats as HH:MM with zero padding', () => {
    expect(toLocalTimeString(wednesday)).toBe('14:30');
    expect(toLocalTimeString(new Date(2026, 0, 5, 9, 5))).toBe('09:05');
    expect(toLocalTimeString(new Date(2026, 0, 5, 0, 0))).toBe('00:00');
  });
});

describe('startOfDay', () => {
  it('zeroes the time and keeps the date', () => {
    const d = startOfDay(wednesday);
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 4, 20]);
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('does not mutate its input', () => {
    const input = new Date(wednesday);
    startOfDay(input);
    expect(input.getTime()).toBe(wednesday.getTime());
  });
});

describe('startOfWeek', () => {
  it('returns the Monday of the week', () => {
    const monday = startOfWeek(wednesday);
    expect(monday.getDay()).toBe(1);
    expect(toLocalDateString(monday)).toBe('2026-05-18');
  });

  it('treats Sunday as the last day of the week (not the first)', () => {
    const sunday = new Date(2026, 4, 24); // Sun 2026-05-24
    expect(toLocalDateString(startOfWeek(sunday))).toBe('2026-05-18');
  });
});

describe('addDays', () => {
  it('crosses month boundaries', () => {
    expect(toLocalDateString(addDays(new Date(2026, 4, 31), 1))).toBe('2026-06-01');
    expect(toLocalDateString(addDays(new Date(2026, 5, 1), -1))).toBe('2026-05-31');
  });
});

describe('rangeFor', () => {
  it('day: [startOfDay, +1d) at 1min resolution', () => {
    const { from, to, resolution, period } = rangeFor('day', wednesday);
    expect(toLocalDateString(from)).toBe('2026-05-20');
    expect(from.getHours()).toBe(0);
    expect(toLocalDateString(to)).toBe('2026-05-21');
    expect(resolution).toBe('1min');
    expect(period).toBe('day');
  });

  it('week: [Monday, +7d) at 1hour resolution', () => {
    const { from, to, resolution, period } = rangeFor('week', wednesday);
    expect(toLocalDateString(from)).toBe('2026-05-18');
    expect(toLocalDateString(to)).toBe('2026-05-25');
    expect(resolution).toBe('1hour');
    expect(period).toBe('week');
  });

  it('month: [1st, 1st of next month) at 1day resolution', () => {
    const { from, to, resolution, period } = rangeFor('month', wednesday);
    expect(toLocalDateString(from)).toBe('2026-05-01');
    expect(toLocalDateString(to)).toBe('2026-06-01');
    expect(resolution).toBe('1day');
    expect(period).toBe('month');
  });
});

describe('dayLabel', () => {
  it('week view: short German weekday without trailing dot', () => {
    expect(dayLabel('week', wednesday.getTime())).toBe('Mi');
  });

  it('month view: day of month', () => {
    expect(dayLabel('month', wednesday.getTime())).toBe('20');
  });

  it('day view: HH:MM time', () => {
    expect(dayLabel('day', wednesday.getTime())).toBe('14:30');
  });
});

describe('periodLabelFor', () => {
  it('week view: ISO calendar week with Mon–Sun range', () => {
    // 2026-05-18 (Mon) starts ISO week 21.
    const label = periodLabelFor('week', wednesday);
    expect(label).toContain('KW 21');
    expect(label).toContain('18.');
    expect(label).toContain('24.');
  });

  it('week view: year boundary belongs to the ISO week of its Thursday', () => {
    // Thu 2026-01-01 -> ISO week 1; Mon 2025-12-29 starts that week.
    expect(periodLabelFor('week', new Date(2025, 11, 29))).toContain('KW 1');
  });

  it('month view: German month name and year', () => {
    expect(periodLabelFor('month', wednesday)).toBe('Mai 2026');
  });
});
