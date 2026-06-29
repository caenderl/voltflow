import { Component, OnInit, computed, inject, signal } from '@angular/core';
import type { EChartsCoreOption } from 'echarts/core';
import type {
  DataRange,
  EnergyBalance,
  EnergySummary,
  MeterReading,
  SeriesResponse,
  SmaConfig,
  SmaReading,
  Tariff,
  WallboxConfig,
  WallboxReading,
} from '@org/shared-types';
import { WALLBOX_STATUS_LABELS } from '@org/shared-types';
import { LiveService } from '../core/live.service';
import { MeterApiService } from '../core/meter-api.service';
import { APP_VERSION } from '../../version';
import { type View, rangeFor, startOfDay, periodLabelFor, dayLabel } from '../core/date-utils';
import { netWatts, signedPowerChart, liveSparkChart, energySlots, slotKey, round2, ONE_DAY, isoToSlotKey } from '../core/chart-utils';
import { ConfigModalComponent, type ConfigSaveEvent } from './config-modal/config-modal.component';
import { LiveViewComponent, type FlowState } from './live-view/live-view.component';
import { HistoryViewComponent, type Costs } from './history-view/history-view.component';
import type { WallboxState } from './wallbox-card/wallbox-card.component';
import type { SmaState } from './sma-card/sma-card.component';
import type { WallboxDailySummary } from '@org/shared-types';

interface LivePoint {
  time: string;
  grid: number | null;
  pv: number | null;
}

// Surplus (W) from which charging makes sense (~6 A single-phase). Configurable later.
const CHARGE_THRESHOLD_W = 1400;

// Rolling window shown in the live hero chart.
const LIVE_WINDOW_MIN = 10;
const LIVE_WINDOW_MS = LIVE_WINDOW_MIN * 60 * 1000;

/** Append points to a time-series buffer, keeping it sorted, de-duped by
 *  timestamp and trimmed to the live window (relative to the newest point). */
function appendWindowed<T extends { time: string }>(existing: T[], incoming: T[]): T[] {
  const byTime = new Map<number, T>();
  for (const p of existing) byTime.set(new Date(p.time).getTime(), p);
  for (const p of incoming) byTime.set(new Date(p.time).getTime(), p);
  const sorted = [...byTime.entries()].sort((a, b) => a[0] - b[0]);
  const newest = sorted.length ? sorted[sorted.length - 1][0] : Date.now();
  const cutoff = newest - LIVE_WINDOW_MS;
  return sorted.filter(([t]) => t >= cutoff).map(([, p]) => p);
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [ConfigModalComponent, LiveViewComponent, HistoryViewComponent],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit {
  private readonly api = inject(MeterApiService);
  private readonly live = inject(LiveService);

  readonly appVersion = APP_VERSION;

  readonly view = signal<View>('live');
  readonly refDate = signal<Date>(new Date());
  readonly dataRange = signal<DataRange | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly latest = signal<MeterReading | null>(null);
  readonly today = signal<EnergySummary | null>(null);
  private readonly liveBuffer = signal<LivePoint[]>([]);

  private readonly series = signal<SeriesResponse | null>(null);
  readonly energy = signal<EnergySummary | null>(null);

  readonly tariff = signal<Tariff | null>(null);
  readonly configOpen = signal(false);

  readonly wallbox = signal<WallboxReading | null>(null);
  readonly wallboxConfig = signal<WallboxConfig | null>(null);
  readonly wallboxDailyEnergy = signal<WallboxDailySummary[]>([]);

  readonly sma = signal<SmaReading | null>(null);
  readonly smaConfig = signal<SmaConfig | null>(null);
  readonly balance = signal<EnergyBalance | null>(null);

  readonly wallboxName = computed(() => this.wallboxConfig()?.name?.trim() || 'Wallbox');

  readonly smaName = computed(() => this.smaConfig()?.name?.trim() || 'PV-Anlage');

  readonly smaState = computed<SmaState | null>(() => {
    const s = this.sma();
    if (!s) return null;
    return {
      productionW: s.gridPower ?? 0,
      dailyYieldKwh: (s.dailyYieldWh ?? 0) / 1000,
      asleep: s.asleep,
    };
  });

  readonly wallboxState = computed<WallboxState | null>(() => {
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

  readonly hasTariff = computed(() => {
    const t = this.tariff();
    return t != null && t.importCtPerKwh != null && t.exportCtPerKwh != null;
  });

  readonly costs = computed<Costs | null>(() => {
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

  readonly flow = computed<FlowState>(() => {
    const r = this.latest();
    const imp = r?.gridToHomePower ?? 0;
    const exp = r?.pvToGridPower ?? 0;
    if (exp > 0) {
      return { mode: 'export', watts: exp, charging: exp >= CHARGE_THRESHOLD_W };
    }
    if (imp > 0) return { mode: 'import', watts: imp, charging: false };
    return { mode: 'idle', watts: 0, charging: false };
  });

  readonly periodLabel = computed(() => periodLabelFor(this.view(), this.refDate()));

  readonly canPrev = computed(() => {
    const r = this.dataRange();
    if (!r?.first) return false;
    const { from } = rangeFor(this.view(), this.refDate());
    return new Date(r.first) < from;
  });

  readonly canNext = computed(() => {
    const { to } = rangeFor(this.view(), this.refDate());
    return to <= startOfDay(new Date());
  });

  readonly liveSpark = computed(() => {
    const buf = this.liveBuffer();
    const now = Date.now();
    return liveSparkChart(
      buf.map((p) => [p.time, netWatts(p.grid, p.pv)] as [string, number]),
      {
        min: new Date(now - LIVE_WINDOW_MS).toISOString(),
        max: new Date(now).toISOString(),
      },
    );
  });

  readonly powerChart = computed(() => {
    const view = this.view();
    const s = this.series();
    const points = s?.points ?? [];
    return signedPowerChart(
      points.map(
        (p) => [p.time, netWatts(p.gridToHomePowerAvg, p.pvToGridPowerAvg)] as [string, number],
      ),
      {
        axisFormat: (v: number) => dayLabel(view, v),
        minInterval: view === 'week' ? ONE_DAY : undefined,
        min: s?.from,
        max: s?.to,
      },
    );
  });

  readonly energyChart = computed(() => {
    const view = this.view();
    const buckets = this.energy()?.buckets ?? [];
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
        valueFormatter: (v: number) =>
          `${Math.abs(Number(v)).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kWh`,
      },
      legend: { data: ['Bezug', 'Einspeisung'], top: 0, textStyle: { color: '#c9c5d0' } },
      grid: { left: 50, right: 20, top: 40, bottom: 30 },
      xAxis: {
        type: 'category',
        data: slots.map((s) => s.label),
        // Thin labels automatically on narrow screens instead of forcing all.
        axisLabel: { color: '#948f9c', interval: 'auto', hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        name: 'kWh',
        axisLabel: { color: '#948f9c', formatter: (v: number) => v.toLocaleString('de-DE') },
        splitLine: { lineStyle: { color: '#2a2a30' } },
      },
      series: [
        {
          name: 'Bezug',
          type: 'bar',
          stack: 'energy',
          itemStyle: { color: '#ff8a80' },
          data: slots.map((s) => round2(byKey.get(s.key)?.imp ?? 0)),
        },
        {
          name: 'Einspeisung',
          type: 'bar',
          stack: 'energy',
          itemStyle: { color: '#7fe0a3' },
          data: slots.map((s) => -round2(byKey.get(s.key)?.exp ?? 0)),
        },
      ],
    };
  });

  readonly wallboxDailyChart = computed<EChartsCoreOption | null>(() => {
    const data = this.wallboxDailyEnergy();
    if (data.length === 0) return null;
    const view = this.view();
    const slots = energySlots(view, this.refDate());
    const byKey = new Map(data.map((d) => [isoToSlotKey(d.day), d.chargedKwh]));
    return {
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: number) =>
          `${Number(v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kWh`,
      },
      grid: { left: 50, right: 20, top: 20, bottom: 30 },
      xAxis: {
        type: 'category',
        data: slots.map((s) => s.label),
        axisLabel: { color: '#948f9c', interval: 'auto', hideOverlap: true },
      },
      yAxis: {
        type: 'value',
        name: 'kWh',
        axisLabel: { color: '#948f9c', formatter: (v: number) => v.toLocaleString('de-DE') },
        splitLine: { lineStyle: { color: '#2a2a30' } },
      },
      series: [
        {
          name: 'Geladen',
          type: 'bar',
          itemStyle: { color: '#aac7ff' },
          data: slots.map((s) => round2(byKey.get(s.key) ?? 0)),
        },
      ],
    };
  });

  ngOnInit(): void {
    this.backfillLive();
    this.live.readings$().subscribe((r) => {
      this.latest.set(r);
      this.liveBuffer.set(
        appendWindowed(this.liveBuffer(), [
          { time: r.time, grid: r.gridToHomePower, pv: r.pvToGridPower },
        ]),
      );
    });
    this.live.wallboxReadings$().subscribe((w) => this.wallbox.set(w));
    this.live.smaReadings$().subscribe((s) => this.sma.set(s));
    this.loadToday();
    this.api.range().subscribe({ next: (r) => this.dataRange.set(r), error: () => undefined });
    this.api.tariff().subscribe({ next: (t) => this.tariff.set(t), error: () => undefined });
    this.api.wallboxConfig().subscribe({
      next: (c) => this.wallboxConfig.set(c),
      error: () => undefined,
    });
    this.api.smaConfig().subscribe({
      next: (c) => this.smaConfig.set(c),
      error: () => undefined,
    });
    setInterval(() => this.loadToday(), 5 * 60 * 1000);
  }

  openConfig(): void {
    this.configOpen.set(true);
  }

  closeConfig(): void {
    this.configOpen.set(false);
  }

  onConfigSave(event: ConfigSaveEvent): void {
    this.api.saveWallboxConfig(event.wallbox).subscribe({
      next: (saved) => this.wallboxConfig.set(saved),
      error: () => this.error.set('Wallbox-Konfiguration konnte nicht gespeichert werden.'),
    });
    this.api.saveSmaConfig(event.sma).subscribe({
      next: (saved) => this.smaConfig.set(saved),
      error: () => this.error.set('SMA-Konfiguration konnte nicht gespeichert werden.'),
    });
    this.api.saveTariff(event.tariff).subscribe({
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
    // Today's energy balance (self-consumption / autarky) for the live SMA card.
    const from = startOfDay(new Date());
    const to = new Date();
    this.api.energyBalance(from, to).subscribe({
      next: (b) => this.balance.set(b),
      error: () => undefined,
    });
  }

  /** Seed the live buffers with the last window of data so the hero chart is
   *  populated immediately instead of filling up over time. */
  private backfillLive(): void {
    const to = new Date();
    const from = new Date(to.getTime() - LIVE_WINDOW_MS);
    this.api.series(from, to, 'raw').subscribe({
      next: (s) => {
        const points = s.points.map((p) => ({
          time: p.time,
          grid: p.gridToHomePowerAvg,
          pv: p.pvToGridPowerAvg,
        }));
        this.liveBuffer.set(appendWindowed(this.liveBuffer(), points));
      },
      error: () => undefined,
    });
  }

  select(view: View): void {
    this.view.set(view);
    this.refDate.set(new Date());
    this.wallboxDailyEnergy.set([]);
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
      error: () => this.error.set('Daten konnten nicht geladen werden (Backend erreichbar?).'),
    });
    if (view === 'week' || view === 'month') {
      this.api.wallboxDailyEnergy(from, to).subscribe({
        next: (d) => this.wallboxDailyEnergy.set(d),
        error: () => this.wallboxDailyEnergy.set([]),
      });
    }
  }
}
