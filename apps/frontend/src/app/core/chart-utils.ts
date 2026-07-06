import type { EChartsCoreOption } from 'echarts/core';
import { type View, dayLabel, startOfDay, startOfWeek, addDays } from './date-utils';

export const ONE_DAY = 24 * 60 * 60 * 1000;
export const TWO_HOURS = 2 * 60 * 60 * 1000;

/** Explicit tick timestamps [min, min+step, ..., max], for forcing a fixed
 *  time-axis tick spacing (see signedPowerChart's tickIntervalMs). */
function fixedTimeTicks(min: string, max: string, stepMs: number): number[] {
  const start = new Date(min).getTime();
  const end = new Date(max).getTime();
  const ticks: number[] = [];
  for (let t = start; t <= end; t += stepMs) ticks.push(t);
  return ticks;
}

/** Central chart palette - single source for all ECharts colors. */
export const CHART_COLORS = {
  /** grid import (red) */
  import: '#ff8a80',
  /** feed-in / PV export (green) */
  export: '#7fe0a3',
  /** wallbox charging (blue) */
  charge: '#aac7ff',
  /** PV production (amber) */
  production: '#ffd54f',
  axisLabel: '#948f9c',
  gridLine: '#2a2a30',
  legendText: '#c9c5d0',
  zeroLine: '#6b6b73',
} as const;

/** "1.234,57 kWh" tooltip label (absolute value, de-DE); "–" for gaps. */
function kwhLabel(v: number | null): string {
  if (v == null) return '–';
  return `${Math.abs(Number(v)).toLocaleString('de-DE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} kWh`;
}

/** Append points to a time-series buffer, keeping it sorted, de-duped by
 *  timestamp and trimmed to `windowMs` (relative to the newest point). */
export function appendWindowed<T extends { time: string }>(
  existing: T[],
  incoming: T[],
  windowMs: number,
): T[] {
  const byTime = new Map<number, T>();
  for (const p of existing) byTime.set(new Date(p.time).getTime(), p);
  for (const p of incoming) byTime.set(new Date(p.time).getTime(), p);
  const sorted = [...byTime.entries()].sort((a, b) => a[0] - b[0]);
  const newest = sorted.length ? sorted[sorted.length - 1][0] : Date.now();
  const cutoff = newest - windowMs;
  return sorted.filter(([t]) => t >= cutoff).map(([, p]) => p);
}

/**
 * Convert an ISO date string returned by the backend ("2026-05-25") to the
 * slot-key format used by energySlots / localDateKey ("2026-4-25").
 * The month is 0-indexed in slot keys to match JS Date.getMonth().
 */
export function isoToSlotKey(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${y}-${m - 1}-${d}`;
}

export function netWatts(grid: number | null, pv: number | null): number {
  return (grid ?? 0) - (pv ?? 0);
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

interface Slot {
  key: string;
  label: string;
}

function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function slotKey(view: View, ms: number): string {
  if (view === 'day') return String(new Date(ms).getHours());
  return localDateKey(ms);
}

/**
 * 5-minute-of-day slots for the day-view lines (288 per day). Coarser than raw
 * minutes so the per-minute counter quantization (PV yield is only ~10-70 Wh
 * per minute, rounded to 10 Wh) and single-minute sampling gaps average out
 * into a smooth curve instead of a saw-tooth.
 */
export function fiveMinuteSlots(ref: Date): Slot[] {
  const slots: Slot[] = [];
  const base = startOfDay(ref);
  for (let i = 0; i < (24 * 60) / 5; i++) {
    const d = new Date(base);
    d.setMinutes(i * 5);
    slots.push({ key: String(i), label: dayLabel('day', d.getTime()) });
  }
  return slots;
}

/**
 * Sum sub-5-minute API rows (or raw readings) into fiveMinuteSlots keys (local
 * 5-minute bucket of day). Accumulates on key collision: on the DST fall-back
 * day two UTC buckets can map to the same local bucket - a plain `new Map(...)`
 * would silently drop one of them.
 */
export function sumByFiveMinKey<T extends { time: string }>(
  rows: T[],
  value: (row: T) => number,
): Map<string, number> {
  const byKey = new Map<string, number>();
  for (const r of rows) {
    const d = new Date(r.time);
    const k = String(Math.floor((d.getHours() * 60 + d.getMinutes()) / 5));
    byKey.set(k, (byKey.get(k) ?? 0) + value(r));
  }
  return byKey;
}

export function energySlots(view: View, ref: Date): Slot[] {
  const slots: Slot[] = [];
  if (view === 'day') {
    const base = startOfDay(ref);
    for (let h = 0; h < 24; h++) {
      const d = new Date(base);
      d.setHours(h);
      slots.push({ key: String(h), label: dayLabel('day', d.getTime()) });
    }
  } else if (view === 'week') {
    const base = startOfWeek(ref);
    for (let i = 0; i < 7; i++) {
      const d = addDays(base, i);
      slots.push({ key: localDateKey(d.getTime()), label: dayLabel('week', d.getTime()) });
    }
  } else {
    const y = ref.getFullYear();
    const m = ref.getMonth();
    const days = new Date(y, m + 1, 0).getDate();
    for (let day = 1; day <= days; day++) {
      const d = new Date(y, m, day);
      slots.push({ key: localDateKey(d.getTime()), label: String(day) });
    }
  }
  return slots;
}

/** Compact watt label for the live y-axis (e.g. 2500 -> "2,5k", -800 -> "-800"). */
function wattLabel(v: number): string {
  return Math.abs(v) >= 1000 ? `${(v / 1000).toLocaleString('de-DE')}k` : `${v}`;
}

/**
 * Compact live chart for the hero: signed net grid power (import red above 0,
 * feed-in green below 0). No tooltip; a faint zero line marks the import/export
 * boundary. The y-axis auto-scales to the data so the magnitude is readable.
 * The time axis is fixed to [min, max] so the window stays constant.
 */
export function liveSparkChart(
  meter: [string, number][],
  opts: { min?: string; max?: string } = {},
): EChartsCoreOption {
  const importData = meter.map(([t, v]) => [t, v >= 0 ? v : null] as [string, number | null]);
  const exportData = meter.map(([t, v]) => [t, v < 0 ? v : null] as [string, number | null]);
  const line = (name: string, color: string, d: [string, number | null][]) => ({
    name,
    type: 'line' as const,
    showSymbol: false,
    smooth: true,
    connectNulls: false,
    lineStyle: { width: 2 },
    itemStyle: { color },
    areaStyle: { opacity: 0.18 },
    data: d,
  });
  return {
    grid: { left: 46, right: 12, top: 10, bottom: 6 },
    xAxis: { type: 'time', show: false, min: opts.min, max: opts.max },
    yAxis: {
      type: 'value',
      splitNumber: 3,
      axisLabel: { color: CHART_COLORS.axisLabel, formatter: (v: number) => wattLabel(v) },
      splitLine: { lineStyle: { color: CHART_COLORS.gridLine } },
    },
    series: [
      {
        ...line('Bezug', CHART_COLORS.import, importData),
        // Faint horizontal zero line (import above / feed-in below).
        markLine: {
          silent: true,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: CHART_COLORS.zeroLine, width: 1, opacity: 0.7 },
          data: [{ yAxis: 0 }],
        },
      },
      line('Einspeisung', CHART_COLORS.export, exportData),
    ],
  };
}

/**
 * Signed net grid power: import (red) above 0, feed-in (green) below 0.
 * Two series, but CLAMPED rather than null-split: import = max(v, 0),
 * export = min(v, 0). Both lines are therefore continuous (they ride along 0
 * when the other sign is active), so the curve stays connected across zero
 * crossings — a null-split breaks into invisible isolated points when the sign
 * flips hour to hour. (visualMap colouring crashes on line series in our
 * ECharts build, so we colour via two series.) Used by the history power chart.
 */
export function signedPowerChart(
  data: [string, number][],
  opts: {
    axisFormat?: string | ((value: number) => string);
    /** Force an exact tick every N ms (e.g. TWO_HOURS), anchored at opts.min.
     *  ECharts' automatic minInterval/maxInterval on a time axis doesn't
     *  reliably land on the requested spacing, so this computes the explicit
     *  tick timestamps instead (requires both min and max to be set). */
    tickIntervalMs?: number;
    min?: string;
    max?: string;
  } = {},
): EChartsCoreOption {
  const importData = data.map(([t, v]) => [t, Math.max(v, 0)] as [string, number]);
  const exportData = data.map(([t, v]) => [t, Math.min(v, 0)] as [string, number]);
  const lineSeries = (name: string, color: string, d: [string, number][]) => ({
    name,
    type: 'line' as const,
    showSymbol: false,
    smooth: true,
    lineStyle: { width: 2 },
    itemStyle: { color },
    areaStyle: { opacity: 0.18 },
    data: d,
  });
  const ticks =
    opts.tickIntervalMs && opts.min && opts.max
      ? fixedTimeTicks(opts.min, opts.max, opts.tickIntervalMs)
      : undefined;
  return {
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: number) => `${Math.abs(Math.round(Number(v)))} W`,
    },
    grid: { left: 60, right: 20, top: 20, bottom: 30 },
    xAxis: {
      type: 'time',
      min: opts.min,
      max: opts.max,
      axisTick: { customValues: ticks },
      axisLabel: { color: CHART_COLORS.axisLabel, formatter: opts.axisFormat, customValues: ticks },
    },
    yAxis: {
      type: 'value',
      name: 'W',
      axisLabel: { color: CHART_COLORS.axisLabel },
      splitLine: { lineStyle: { color: CHART_COLORS.gridLine } },
    },
    series: [
      lineSeries('Bezug', CHART_COLORS.import, importData),
      lineSeries('Einspeisung', CHART_COLORS.export, exportData),
    ],
  };
}

export interface EnergyBarSeries {
  name: string;
  color: string;
  /** one value per slot, already signed (negative bars hang below 0);
   *  null renders a gap (line series: no point instead of a fake 0) */
  data: (number | null)[];
  /** 'bar' (default) or 'line' - lines are drawn on top of the bars. */
  type?: 'bar' | 'line';
  /** Set to false to keep this bar out of the shared stack (opts.stacked)
   *  even though the others stack together - renders as its own column. */
  stack?: string | false;
}

/**
 * Stacked-capable kWh chart (bars and/or lines) over category slots (hours of
 * a day, days of a week/month). Shared by the energy, PV and wallbox charts -
 * only the series differ.
 */
export function energyBarChart(
  labels: string[],
  series: EnergyBarSeries[],
  opts: { legend?: boolean; stacked?: boolean; xAxisLabelInterval?: number | 'auto' } = {},
): EChartsCoreOption {
  return {
    tooltip: { trigger: 'axis', valueFormatter: kwhLabel },
    ...(opts.legend
      ? {
          legend: {
            data: series.map((s) => s.name),
            top: 0,
            textStyle: { color: CHART_COLORS.legendText },
          },
        }
      : {}),
    grid: { left: 50, right: 20, top: opts.legend ? 40 : 20, bottom: 30 },
    xAxis: {
      type: 'category',
      data: labels,
      // Thin labels automatically on narrow screens instead of forcing all,
      // unless a fixed interval is requested (e.g. many-slot minute charts,
      // where 'auto' wouldn't reliably land on round-hour boundaries).
      axisLabel: {
        color: CHART_COLORS.axisLabel,
        interval: opts.xAxisLabelInterval ?? 'auto',
        hideOverlap: true,
      },
    },
    yAxis: {
      type: 'value',
      name: 'kWh',
      axisLabel: {
        color: CHART_COLORS.axisLabel,
        formatter: (v: number) => v.toLocaleString('de-DE'),
      },
      splitLine: { lineStyle: { color: CHART_COLORS.gridLine } },
    },
    series: series.map((s) => {
      const type = s.type ?? 'bar';
      const stack = s.stack === false ? undefined : (s.stack ?? (opts.stacked && type === 'bar' ? 'energy' : undefined));
      return {
        name: s.name,
        type,
        ...(stack ? { stack } : {}),
        // smoothMonotone keeps the cubic interpolation from over/undershooting
        // (e.g. dipping below 0 kWh between the night zeros and the PV ramp).
        ...(type === 'line'
          ? { smooth: true, smoothMonotone: 'x', showSymbol: false, lineStyle: { width: 2 } }
          : {}),
        itemStyle: { color: s.color },
        data: s.data,
      };
    }),
  };
}
