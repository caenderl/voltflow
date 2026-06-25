import type { EnergyPeriod, SeriesResolution } from '@org/shared-types';

export type View = 'live' | 'day' | 'week' | 'month';

export interface RangeSpec {
  from: Date;
  to: Date;
  resolution: SeriesResolution;
  period: EnergyPeriod;
  date: Date;
}

export function rangeFor(view: View, ref: Date): RangeSpec {
  if (view === 'week') {
    const from = startOfWeek(ref);
    return { from, to: addDays(from, 7), resolution: '1hour', period: 'week', date: ref };
  }
  if (view === 'month') {
    const from = startOfMonth(ref);
    return { from, to: addMonths(from, 1), resolution: '1day', period: 'month', date: from };
  }
  const from = startOfDay(ref);
  return { from, to: addDays(from, 1), resolution: '1min', period: 'day', date: ref };
}

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7; // Mon=0
  x.setDate(x.getDate() - day);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

export function isoWeek(d: Date): number {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7)); // nearest Thursday
  const week1 = new Date(t.getFullYear(), 0, 4);
  return (
    1 +
    Math.round(
      ((t.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7,
    )
  );
}

export function dayLabel(view: View, ms: number): string {
  const d = new Date(ms);
  if (view === 'week') return d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '');
  if (view === 'month') return String(d.getDate());
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}

export function periodLabelFor(view: View, ref: Date): string {
  if (view === 'week') {
    const start = startOfWeek(ref);
    const end = addDays(start, 6);
    const s = start.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
    const e = end.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
    return `KW ${isoWeek(start)} · ${s} – ${e}`;
  }
  if (view === 'month') {
    return ref.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  }
  return ref.toLocaleDateString('de-DE', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
