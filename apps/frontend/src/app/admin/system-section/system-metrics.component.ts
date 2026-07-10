import { Component, computed, input } from '@angular/core';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { SystemHealth } from '@org/shared-types';
import { CHART_COLORS } from '../../core/chart-utils';
import { type SysPoint, sysSparkChart } from './system-charts';

const GB = 1024 ** 3;

/** Green/amber/red by a 0..1 utilization ratio. */
function ratioColor(ratio: number): string {
  if (ratio >= 0.9) return CHART_COLORS.import; // red
  if (ratio >= 0.7) return CHART_COLORS.production; // amber
  return CHART_COLORS.export; // green
}

function gb(bytes: number): string {
  return (bytes / GB).toLocaleString('de-DE', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

/**
 * Three host-metric cards (CPU load / memory / disk), each with the current
 * value and a sparkline over the rolling window. Purely presentational — the
 * parent owns the polling and the history buffer.
 */
@Component({
  selector: 'app-system-metrics',
  standalone: true,
  imports: [NgxEchartsDirective],
  templateUrl: './system-metrics.component.html',
  styleUrl: './system-metrics.component.scss',
})
export class SystemMetricsComponent {
  /** Rolling window of snapshots, oldest first. */
  readonly history = input.required<SystemHealth[]>();

  private readonly latest = computed(() => this.history().at(-1) ?? null);

  // --- CPU load --------------------------------------------------------------
  readonly loadRatio = computed(() => {
    const h = this.latest();
    if (!h) return 0;
    return h.load.cores ? h.load.avg1 / h.load.cores : 0;
  });
  readonly loadValue = computed(() => {
    const h = this.latest();
    return h ? h.load.avg1.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '–';
  });
  readonly loadSub = computed(() => {
    const h = this.latest();
    return h ? `${h.load.cores} Kerne · ${Math.round(this.loadRatio() * 100)} %` : '';
  });
  readonly loadChart = computed(() =>
    sysSparkChart(
      this.history().map((h) => [new Date(h.time).getTime(), h.load.avg1] as SysPoint),
      { color: ratioColor(this.loadRatio()), unit: '', digits: 2 },
    ),
  );

  // --- Memory ----------------------------------------------------------------
  readonly memRatio = computed(() => {
    const m = this.latest()?.memory;
    return m && m.totalBytes ? m.usedBytes / m.totalBytes : 0;
  });
  readonly memValue = computed(() => `${Math.round(this.memRatio() * 100)} %`);
  readonly memSub = computed(() => {
    const m = this.latest()?.memory;
    return m ? `${gb(m.usedBytes)} / ${gb(m.totalBytes)} GB` : '';
  });
  readonly memChart = computed(() =>
    sysSparkChart(
      this.history().map(
        (h) => [new Date(h.time).getTime(), h.memory.totalBytes ? (h.memory.usedBytes / h.memory.totalBytes) * 100 : 0] as SysPoint,
      ),
      { color: ratioColor(this.memRatio()), max: 100, unit: '%', digits: 0 },
    ),
  );

  // --- Disk ------------------------------------------------------------------
  readonly hasDisk = computed(() => this.latest()?.disk != null);
  readonly diskRatio = computed(() => {
    const d = this.latest()?.disk;
    return d && d.totalBytes ? d.usedBytes / d.totalBytes : 0;
  });
  readonly diskValue = computed(() => (this.hasDisk() ? `${Math.round(this.diskRatio() * 100)} %` : '–'));
  readonly diskSub = computed(() => {
    const d = this.latest()?.disk;
    return d ? `${gb(d.availableBytes)} GB frei · ${gb(d.totalBytes)} GB` : 'nicht verfügbar';
  });
  readonly diskColor = computed(() => ratioColor(this.diskRatio()));
  readonly diskPct = computed(() => Math.round(this.diskRatio() * 100));

  readonly loadColor = computed(() => ratioColor(this.loadRatio()));
  readonly memColor = computed(() => ratioColor(this.memRatio()));
}
