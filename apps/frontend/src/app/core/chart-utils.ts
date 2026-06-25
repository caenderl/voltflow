import type { EChartsCoreOption } from 'echarts/core';
import { type View, dayLabel, startOfDay, startOfWeek, addDays } from './date-utils';

export const ONE_DAY = 24 * 60 * 60 * 1000;

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

export interface Slot {
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

export function signedPowerChart(
  data: [string, number][],
  opts: {
    spark?: boolean;
    axisFormat?: string | ((value: number) => string);
    minInterval?: number;
    min?: string;
    max?: string;
  } = {},
): EChartsCoreOption {
  const spark = opts.spark === true;
  const importData = data.map(([t, v]) => [t, v >= 0 ? v : null] as [string, number | null]);
  const exportData = data.map(([t, v]) => [t, v < 0 ? v : null] as [string, number | null]);
  const lineSeries = (name: string, color: string, d: [string, number | null][]) => ({
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
    tooltip: {
      trigger: 'axis',
      valueFormatter: (v: number) => `${Math.abs(Math.round(Number(v)))} W`,
    },
    grid: spark
      ? { left: 0, right: 0, top: 8, bottom: 0 }
      : { left: 60, right: 20, top: 20, bottom: 30 },
    xAxis: {
      type: 'time',
      show: !spark,
      min: opts.min,
      max: opts.max,
      minInterval: opts.minInterval,
      axisLabel: { color: '#948f9c', formatter: opts.axisFormat },
    },
    yAxis: {
      type: 'value',
      show: !spark,
      name: spark ? undefined : 'W',
      axisLabel: { color: '#948f9c' },
      splitLine: { lineStyle: { color: '#2a2a30' } },
    },
    series: [
      lineSeries('Bezug', '#ff8a80', importData),
      lineSeries('Einspeisung', '#7fe0a3', exportData),
    ],
  };
}
