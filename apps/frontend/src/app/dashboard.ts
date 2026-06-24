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
type FlowMode = 'export' | 'import' | 'idle';

interface LivePoint {
  time: string;
  grid: number | null;
  pv: number | null;
}

// Surplus (W) from which charging makes sense (~6 A single-phase). Configurable later.
const CHARGE_THRESHOLD_W = 1400;

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
  readonly today = signal<EnergySummary | null>(null);
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

  /** Current grid flow state derived from the latest reading. */
  readonly flow = computed<{ mode: FlowMode; watts: number; charging: boolean }>(() => {
    const r = this.latest();
    const imp = r?.gridToHomePower ?? 0;
    const exp = r?.pvToGridPower ?? 0;
    if (exp > 0) {
      return { mode: 'export', watts: exp, charging: exp >= CHARGE_THRESHOLD_W };
    }
    if (imp > 0) return { mode: 'import', watts: imp, charging: false };
    return { mode: 'idle', watts: 0, charging: false };
  });

  ngOnInit(): void {
    this.live.readings$().subscribe((r) => {
      this.latest.set(r);
      const buf = [...this.liveBuffer(), { time: r.time, grid: r.gridToHomePower, pv: r.pvToGridPower }];
      this.liveBuffer.set(buf.slice(-120)); // ~10 min at 5s interval
    });
    this.loadToday();
    // Refresh today's totals every 5 min
    setInterval(() => this.loadToday(), 5 * 60 * 1000);
  }

  private loadToday(): void {
    this.api.energy('day', new Date()).subscribe({
      next: (e) => this.today.set(e),
      error: () => undefined,
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

  /** Minimal sparkline for the live hero (signed net: import + / export -). */
  readonly liveSpark = computed<EChartsCoreOption>(() => {
    const buf = this.liveBuffer();
    return signedPowerChart(
      buf.map((p) => [p.time, netWatts(p.grid, p.pv)] as [string, number]),
      { spark: true },
    );
  });

  readonly powerChart = computed<EChartsCoreOption>(() => {
    const view = this.view();
    const s = this.series();
    const points = s?.points ?? [];
    return signedPowerChart(
      points.map(
        (p) => [p.time, netWatts(p.gridToHomePowerAvg, p.pvToGridPowerAvg)] as [string, number],
      ),
      {
        axisFormat: (v: number) => dayLabel(view, v),
        // week -> one tick per day (weekday labels)
        minInterval: view === 'week' ? ONE_DAY : undefined,
        // span the full period so the axis starts at 00:00 / week/month start
        min: s?.from,
        max: s?.to,
      },
    );
  });

  readonly energyChart = computed<EChartsCoreOption>(() => {
    const view = this.view();
    const buckets = this.energy()?.buckets ?? [];
    // Full set of slots for the period (day -> 24h, week -> Mo..So, month ->
    // 1..N), so every day/hour shows even without data.
    const slots = energySlots(view, this.month());
    const byKey = new Map<string, { imp: number; exp: number }>();
    for (const b of buckets) {
      const k = slotKey(view, new Date(b.time).getTime());
      const cur = byKey.get(k) ?? { imp: 0, exp: 0 };
      cur.imp += b.importKwh;
      cur.exp += b.exportKwh;
      byKey.set(k, cur);
    }
    return {
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: number) => `${Math.abs(Number(v)).toFixed(2)} kWh`,
      },
      legend: { data: ['Bezug', 'Einspeisung'], top: 0, textStyle: { color: '#cbd5e1' } },
      grid: { left: 50, right: 20, top: 40, bottom: 30 },
      xAxis: {
        type: 'category',
        data: slots.map((s) => s.label),
        axisLabel: { color: '#94a3b8', interval: 0 },
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
          stack: 'energy',
          itemStyle: { color: '#ef4444' },
          data: slots.map((s) => round2(byKey.get(s.key)?.imp ?? 0)), // import up
        },
        {
          name: 'Einspeisung',
          type: 'bar',
          stack: 'energy',
          itemStyle: { color: '#22c55e' },
          data: slots.map((s) => -round2(byKey.get(s.key)?.exp ?? 0)), // feed-in down
        },
      ],
    };
  });
}

/** Signed net power in W: import positive, feed-in negative. */
function netWatts(grid: number | null, pv: number | null): number {
  return (grid ?? 0) - (pv ?? 0);
}

const ONE_DAY = 24 * 60 * 60 * 1000;

/** X-axis label for a timestamp depending on the view. */
function dayLabel(view: View, ms: number): string {
  const d = new Date(ms);
  if (view === 'week') return d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', ''); // Mo..So
  if (view === 'month') return String(d.getDate()); // 1..31
  return d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); // HH:MM
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Local day key for matching buckets to slots. */
function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Key of the slot a bucket belongs to (day -> hour, else -> local day). */
function slotKey(view: View, ms: number): string {
  if (view === 'day') return String(new Date(ms).getHours());
  return localDateKey(ms);
}

interface Slot {
  key: string;
  label: string;
}

/** Full set of category slots for the period (so empty days/hours still show). */
function energySlots(view: View, monthStr: string): Slot[] {
  const slots: Slot[] = [];
  if (view === 'day') {
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let h = 0; h < 24; h++) {
      const d = new Date(base);
      d.setHours(h);
      slots.push({ key: String(h), label: dayLabel('day', d.getTime()) });
    }
  } else if (view === 'week') {
    const base = startOfWeek(new Date());
    for (let i = 0; i < 7; i++) {
      const d = addDays(base, i);
      slots.push({ key: localDateKey(d.getTime()), label: dayLabel('week', d.getTime()) });
    }
  } else {
    const [y, m] = monthStr.split('-').map(Number);
    const days = new Date(y, m, 0).getDate(); // days in month
    for (let day = 1; day <= days; day++) {
      const d = new Date(y, m - 1, day);
      slots.push({ key: localDateKey(d.getTime()), label: String(day) });
    }
  }
  return slots;
}

/**
 * Signed power chart: import (positive) red above zero, feed-in (negative)
 * green below zero. Split into two area series at the zero line (robust, no
 * visualMap which crashes on area lines).
 */
function signedPowerChart(
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
      axisLabel: { color: '#94a3b8', formatter: opts.axisFormat },
    },
    yAxis: {
      type: 'value',
      show: !spark,
      name: spark ? undefined : 'W',
      axisLabel: { color: '#94a3b8' },
      splitLine: { lineStyle: { color: '#1e293b' } },
    },
    series: [
      lineSeries('Bezug', '#f87171', importData),
      lineSeries('Einspeisung', '#34d399', exportData),
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
