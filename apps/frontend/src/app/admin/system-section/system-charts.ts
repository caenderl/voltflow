import type { EChartsCoreOption } from 'echarts/core';
import { CHART_COLORS } from '../../core/chart-utils';

/** A [timestampMs, value] sample for a system sparkline. */
export type SysPoint = [number, number];

/**
 * Bar chart of the on-host dump sizes, one bar per backup. Bars (not a line):
 * these are a handful of discrete daily events, not a sampled signal, and the
 * gap left by a missed night should read as a gap.
 */
export function backupSizeChart(data: SysPoint[], color: string): EChartsCoreOption {
  return {
    animation: false,
    grid: { left: 4, right: 4, top: 6, bottom: 4 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(20,20,24,0.92)',
      borderWidth: 0,
      textStyle: { color: CHART_COLORS.legendText, fontSize: 12 },
      formatter: (params: unknown) => {
        const p = (params as { value: [number, number] }[])[0];
        if (!p) return '';
        const [t, mb] = p.value;
        const day = new Date(t).toLocaleDateString('de-DE', {
          day: '2-digit',
          month: '2-digit',
        });
        return `${day}<br/>${mb.toLocaleString('de-DE', {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        })} MB`;
      },
    },
    xAxis: { type: 'time', show: false },
    yAxis: { type: 'value', show: false, min: 0 },
    series: [
      {
        type: 'bar',
        // Time axis: without a width the bars collapse to hairlines.
        barMaxWidth: 14,
        itemStyle: { color, borderRadius: [2, 2, 0, 0] },
        data,
      },
    ],
  };
}

/**
 * Minimal area sparkline for a single host metric over the rolling window.
 * `max` fixes the y-axis top (e.g. 100 for a percentage); omit for auto-scale.
 * `unit` is appended in the tooltip.
 */
export function sysSparkChart(
  data: SysPoint[],
  opts: { color: string; max?: number; unit: string; digits?: number },
): EChartsCoreOption {
  const digits = opts.digits ?? 0;
  return {
    animation: false,
    grid: { left: 4, right: 4, top: 6, bottom: 4 },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(20,20,24,0.92)',
      borderWidth: 0,
      textStyle: { color: CHART_COLORS.legendText, fontSize: 12 },
      formatter: (params: unknown) => {
        const p = (params as { value: [number, number] }[])[0];
        if (!p) return '';
        const [t, v] = p.value;
        const time = new Date(t).toLocaleTimeString('de-DE', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        });
        return `${time}<br/>${v.toLocaleString('de-DE', {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        })} ${opts.unit}`;
      },
    },
    xAxis: { type: 'time', show: false },
    yAxis: { type: 'value', show: false, min: 0, max: opts.max },
    series: [
      {
        type: 'line',
        showSymbol: false,
        smooth: true,
        connectNulls: false,
        lineStyle: { width: 2, color: opts.color },
        itemStyle: { color: opts.color },
        areaStyle: { color: opts.color, opacity: 0.16 },
        data,
      },
    ],
  };
}
