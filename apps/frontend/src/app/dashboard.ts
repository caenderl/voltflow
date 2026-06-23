import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsCoreOption } from 'echarts/core';
import type {
  EnergyPeriod,
  EnergySummary,
  MeterReading,
  SeriesResolution,
  SeriesResponse,
} from '@org/shared-types';
import { LiveService } from './live.service';
import { MeterApiService } from './meter-api.service';

type View = 'live' | 'day' | 'week' | 'month';

interface LivePoint {
  time: string;
  grid: number | null;
  pv: number | null;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, NgxEchartsDirective],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit {
  private readonly api = inject(MeterApiService);
  private readonly live = inject(LiveService);

  readonly view = signal<View>('live');
  readonly month = signal<string>(currentMonthStr());
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  // Live
  readonly latest = signal<MeterReading | null>(null);
  private readonly liveBuffer = signal<LivePoint[]>([]);

  // History / energy
  private readonly series = signal<SeriesResponse | null>(null);
  readonly energy = signal<EnergySummary | null>(null);

  readonly views: { id: View; label: string }[] = [
    { id: 'live', label: 'Live' },
    { id: 'day', label: 'Tag' },
    { id: 'week', label: 'Woche' },
    { id: 'month', label: 'Monat' },
  ];

  ngOnInit(): void {
    this.live.readings$().subscribe((r) => {
      this.latest.set(r);
      const buf = [...this.liveBuffer(), { time: r.time, grid: r.gridToHomePower, pv: r.pvToGridPower }];
      this.liveBuffer.set(buf.slice(-120)); // ~10 min at 5s interval
    });
  }

  select(view: View): void {
    this.view.set(view);
    if (view !== 'live') this.load();
  }

  onMonthChange(value: string): void {
    this.month.set(value);
    if (this.view() === 'month') this.load();
  }

  private load(): void {
    const view = this.view();
    const { from, to, resolution, period, date } = rangeFor(view, this.month());
    this.loading.set(true);
    this.error.set(null);
    this.series.set(null);
    this.energy.set(null);
    this.api.series(from, to, resolution).subscribe({
      next: (s) => this.series.set(s),
      complete: () => this.loading.set(false),
      error: () => {
        this.loading.set(false);
        this.error.set('Daten konnten nicht geladen werden (Backend erreichbar?).');
      },
    });
    this.api.energy(period, date).subscribe({
      next: (e) => this.energy.set(e),
      error: () =>
        this.error.set('Daten konnten nicht geladen werden (Backend erreichbar?).'),
    });
  }

  // --- Chart options ---

  readonly liveChart = computed<EChartsCoreOption>(() => {
    const buf = this.liveBuffer();
    return basePowerChart(
      buf.map((p) => [p.time, p.grid] as [string, number | null]),
      buf.map((p) => [p.time, p.pv] as [string, number | null]),
    );
  });

  readonly powerChart = computed<EChartsCoreOption>(() => {
    const s = this.series();
    const points = s?.points ?? [];
    return basePowerChart(
      points.map((p) => [p.time, p.gridToHomePowerAvg] as [string, number | null]),
      points.map((p) => [p.time, p.pvToGridPowerAvg] as [string, number | null]),
    );
  });

  readonly energyChart = computed<EChartsCoreOption>(() => {
    const e = this.energy();
    const buckets = e?.buckets ?? [];
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${v} kWh` },
      legend: { data: ['Bezug', 'Einspeisung'], textStyle: { color: '#cbd5e1' } },
      grid: { left: 50, right: 20, top: 40, bottom: 40 },
      xAxis: {
        type: 'time',
        axisLabel: { color: '#94a3b8' },
      },
      yAxis: {
        type: 'value',
        name: 'kWh',
        axisLabel: { color: '#94a3b8' },
        splitLine: { lineStyle: { color: '#1e293b' } },
      },
      series: [
        {
          name: 'Bezug',
          type: 'bar',
          stack: undefined,
          itemStyle: { color: '#ef4444' },
          data: buckets.map((b) => [b.time, b.importKwh]),
        },
        {
          name: 'Einspeisung',
          type: 'bar',
          itemStyle: { color: '#22c55e' },
          data: buckets.map((b) => [b.time, b.exportKwh]),
        },
      ],
    };
  });
}

function basePowerChart(
  gridData: [string, number | null][],
  pvData: [string, number | null][],
): EChartsCoreOption {
  return {
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${Math.round(v)} W` },
    legend: { data: ['Bezug', 'Einspeisung'], textStyle: { color: '#cbd5e1' } },
    grid: { left: 55, right: 20, top: 40, bottom: 40 },
    xAxis: { type: 'time', axisLabel: { color: '#94a3b8' } },
    yAxis: {
      type: 'value',
      name: 'W',
      axisLabel: { color: '#94a3b8' },
      splitLine: { lineStyle: { color: '#1e293b' } },
    },
    series: [
      {
        name: 'Bezug',
        type: 'line',
        showSymbol: false,
        smooth: true,
        areaStyle: { opacity: 0.15 },
        itemStyle: { color: '#ef4444' },
        data: gridData,
      },
      {
        name: 'Einspeisung',
        type: 'line',
        showSymbol: false,
        smooth: true,
        areaStyle: { opacity: 0.15 },
        itemStyle: { color: '#22c55e' },
        data: pvData,
      },
    ],
  };
}

// --- Time range helpers ---

interface RangeSpec {
  from: Date;
  to: Date;
  resolution: SeriesResolution;
  period: EnergyPeriod;
  date: Date;
}

function rangeFor(view: View, monthStr: string): RangeSpec {
  const now = new Date();
  if (view === 'day') {
    const from = startOfDay(now);
    return { from, to: addDays(from, 1), resolution: '1min', period: 'day', date: now };
  }
  if (view === 'week') {
    const from = startOfWeek(now);
    return { from, to: addDays(from, 7), resolution: '1hour', period: 'week', date: now };
  }
  // month
  const from = startOfMonth(monthStr);
  return { from, to: addMonths(from, 1), resolution: '1day', period: 'month', date: from };
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const day = (x.getDay() + 6) % 7; // Mon=0
  x.setDate(x.getDate() - day);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function startOfMonth(monthStr: string): Date {
  const [y, m] = monthStr.split('-').map(Number);
  return new Date(y, m - 1, 1);
}
function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}
function currentMonthStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
