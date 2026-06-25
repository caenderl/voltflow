import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsCoreOption } from 'echarts/core';
import type {
  DataRange,
  EnergyPeriod,
  EnergySummary,
  MeterReading,
  SeriesResolution,
  SeriesResponse,
  Tariff,
  WallboxConfig,
  WallboxReading,
} from '@org/shared-types';
import { WALLBOX_STATUS_LABELS } from '@org/shared-types';
import { LiveService } from './live.service';
import { MeterApiService } from './meter-api.service';
import { APP_VERSION } from '../version';

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

  readonly appVersion = APP_VERSION;

  readonly view = signal<View>('live');
  /** Reference date of the shown period (day/week/month it falls into). */
  readonly refDate = signal<Date>(new Date());
  /** Available data range, for enabling prev/next. */
  readonly dataRange = signal<DataRange | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  // Live
  readonly latest = signal<MeterReading | null>(null);
  readonly today = signal<EnergySummary | null>(null);
  private readonly liveBuffer = signal<LivePoint[]>([]);

  // History / energy
  private readonly series = signal<SeriesResponse | null>(null);
  readonly energy = signal<EnergySummary | null>(null);

  // Tariff / config
  readonly tariff = signal<Tariff | null>(null);
  readonly configOpen = signal(false);
  // form model (bound via ngModel in the settings modal)
  formProvider = '';
  formImport: number | null = null;
  formExport: number | null = null;

  // Wallbox
  readonly wallbox = signal<WallboxReading | null>(null);
  readonly wallboxConfig = signal<WallboxConfig | null>(null);
  // wallbox form model
  formWbEnabled = false;
  formWbName = '';
  formWbHost = '';
  formWbPort: number | null = 502;
  formWbUnitId: number | null = 1;
  formWbInterval: number | null = 30;

  /** Display name for the wallbox (config name, falls back to "Wallbox"). */
  readonly wallboxName = computed(() => this.wallboxConfig()?.name?.trim() || 'Wallbox');

  /** Live wallbox state for the live view (label + charging flag). */
  readonly wallboxState = computed(() => {
    const w = this.wallbox();
    if (!w) return null;
    const status = w.status ?? 0;
    return {
      statusLabel: WALLBOX_STATUS_LABELS[status] ?? `Status ${status}`,
      charging: status === 2,
      powerW: w.activePowerW ?? 0,
      sessionKwh: (w.sessionEnergyWh ?? 0) / 1000,
    };
  });

  /** True when both work prices are configured -> show costs. */
  readonly hasTariff = computed(() => {
    const t = this.tariff();
    return t != null && t.importCtPerKwh != null && t.exportCtPerKwh != null;
  });

  /** Costs (€) for the currently loaded period, derived from energy × prices. */
  readonly costs = computed(() => {
    const t = this.tariff();
    const e = this.energy();
    if (!t || !e || t.importCtPerKwh == null || t.exportCtPerKwh == null) return null;
    const importCost = (e.importKwh * t.importCtPerKwh) / 100;
    const exportRevenue = (e.exportKwh * t.exportCtPerKwh) / 100;
    return { importCost, exportRevenue, net: importCost - exportRevenue };
  });

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

  /** Period label shown in the navigator (e.g. "Di., 24. Juni 2026"). */
  readonly periodLabel = computed(() => periodLabelFor(this.view(), this.refDate()));

  readonly canPrev = computed(() => {
    const r = this.dataRange();
    if (!r?.first) return false;
    const { from } = rangeFor(this.view(), this.refDate());
    return new Date(r.first) < from;
  });

  readonly canNext = computed(() => {
    const { to } = rangeFor(this.view(), this.refDate());
    return to <= startOfDay(new Date()); // no navigating into the future
  });

  ngOnInit(): void {
    this.live.readings$().subscribe((r) => {
      this.latest.set(r);
      const buf = [...this.liveBuffer(), { time: r.time, grid: r.gridToHomePower, pv: r.pvToGridPower }];
      this.liveBuffer.set(buf.slice(-120)); // ~10 min at 5s interval
    });
    this.live.wallboxReadings$().subscribe((w) => this.wallbox.set(w));
    this.loadToday();
    this.api.range().subscribe({ next: (r) => this.dataRange.set(r), error: () => undefined });
    this.api.tariff().subscribe({ next: (t) => this.tariff.set(t), error: () => undefined });
    this.api.wallboxConfig().subscribe({
      next: (c) => this.wallboxConfig.set(c),
      error: () => undefined,
    });
    // Refresh today's totals every 5 min
    setInterval(() => this.loadToday(), 5 * 60 * 1000);
  }

  openConfig(): void {
    const t = this.tariff();
    this.formProvider = t?.provider ?? '';
    this.formImport = t?.importCtPerKwh ?? null;
    this.formExport = t?.exportCtPerKwh ?? null;
    const w = this.wallboxConfig();
    this.formWbEnabled = w?.enabled ?? false;
    this.formWbName = w?.name ?? '';
    this.formWbHost = w?.host ?? '';
    this.formWbPort = w?.port ?? 502;
    this.formWbUnitId = w?.unitId ?? 1;
    this.formWbInterval = w?.pollIntervalS ?? 30;
    this.configOpen.set(true);
  }

  closeConfig(): void {
    this.configOpen.set(false);
  }

  saveConfig(): void {
    const t: Tariff = {
      provider: this.formProvider.trim() || null,
      importCtPerKwh: this.formImport ?? null,
      exportCtPerKwh: this.formExport ?? null,
    };
    const wb: WallboxConfig = {
      enabled: this.formWbEnabled,
      name: this.formWbName.trim() || null,
      host: this.formWbHost.trim() || null,
      port: this.formWbPort ?? 502,
      unitId: this.formWbUnitId ?? 1,
      pollIntervalS: this.formWbInterval ?? 30,
    };
    // Save both; close once tariff returns (wallbox runs in parallel).
    this.api.saveWallboxConfig(wb).subscribe({
      next: (saved) => this.wallboxConfig.set(saved),
      error: () => this.error.set('Wallbox-Konfiguration konnte nicht gespeichert werden.'),
    });
    this.api.saveTariff(t).subscribe({
      next: (saved) => {
        this.tariff.set(saved);
        this.configOpen.set(false);
      },
      error: () => this.error.set('Tarif konnte nicht gespeichert werden.'),
    });
  }

  private loadToday(): void {
    this.api.energy('day', new Date()).subscribe({
      next: (e) => this.today.set(e),
      error: () => undefined,
    });
  }

  select(view: View): void {
    this.view.set(view);
    this.refDate.set(new Date()); // start at the current period
    if (view !== 'live') this.load();
  }

  prev(): void {
    if (this.canPrev()) this.shift(-1);
  }

  next(): void {
    if (this.canNext()) this.shift(1);
  }

  private shift(dir: -1 | 1): void {
    const d = new Date(this.refDate());
    const v = this.view();
    if (v === 'day') d.setDate(d.getDate() + dir);
    else if (v === 'week') d.setDate(d.getDate() + 7 * dir);
    else d.setMonth(d.getMonth() + dir);
    this.refDate.set(d);
    this.load();
  }

  private load(): void {
    const view = this.view();
    const { from, to, resolution, period, date } = rangeFor(view, this.refDate());
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
    const slots = energySlots(view, this.refDate());
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
      legend: { data: ['Bezug', 'Einspeisung'], top: 0, textStyle: { color: '#c9c5d0' } },
      grid: { left: 50, right: 20, top: 40, bottom: 30 },
      xAxis: {
        type: 'category',
        data: slots.map((s) => s.label),
        axisLabel: { color: '#948f9c', interval: 0 },
      },
      yAxis: {
        type: 'value',
        name: 'kWh',
        axisLabel: { color: '#948f9c' },
        splitLine: { lineStyle: { color: '#2a2a30' } },
      },
      series: [
        {
          name: 'Bezug',
          type: 'bar',
          stack: 'energy',
          itemStyle: { color: '#ff8a80' },
          data: slots.map((s) => round2(byKey.get(s.key)?.imp ?? 0)), // import up
        },
        {
          name: 'Einspeisung',
          type: 'bar',
          stack: 'energy',
          itemStyle: { color: '#7fe0a3' },
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
function energySlots(view: View, ref: Date): Slot[] {
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
    const days = new Date(y, m + 1, 0).getDate(); // days in month
    for (let day = 1; day <= days; day++) {
      const d = new Date(y, m, day);
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

// --- Time range helpers ---

interface RangeSpec {
  from: Date;
  to: Date;
  resolution: SeriesResolution;
  period: EnergyPeriod;
  date: Date;
}

function rangeFor(view: View, ref: Date): RangeSpec {
  if (view === 'week') {
    const from = startOfWeek(ref);
    return { from, to: addDays(from, 7), resolution: '1hour', period: 'week', date: ref };
  }
  if (view === 'month') {
    const from = startOfMonth(ref);
    return { from, to: addMonths(from, 1), resolution: '1day', period: 'month', date: from };
  }
  // day (also the fallback for 'live', unused there)
  const from = startOfDay(ref);
  return { from, to: addDays(from, 1), resolution: '1min', period: 'day', date: ref };
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
function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

/** ISO week number of a date. */
function isoWeek(d: Date): number {
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

/** Human label for the shown period. */
function periodLabelFor(view: View, ref: Date): string {
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
  // day
  return ref.toLocaleDateString('de-DE', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
