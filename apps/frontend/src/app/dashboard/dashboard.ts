import { Component, OnInit, computed, inject, signal } from '@angular/core';
import type { EChartsCoreOption } from 'echarts/core';
import { WALLBOX_STATUS_LABELS } from '@org/shared-types';
import { APP_VERSION } from '../../version';
import {
  CHART_COLORS,
  ONE_DAY,
  TWO_HOURS,
  type CategorySeries,
  categorySeriesChart,
  energySlots,
  minuteBucketSlots,
  isoToSlotKey,
  liveSparkChart,
  netWatts,
  round2,
  signedPowerChart,
  slotKey,
  sumByMinuteBucket,
} from '../core/chart-utils';
import { type View, dayLabel, periodLabelFor, rangeFor, startOfDay } from '../core/date-utils';
import {
  ConfigModalComponent,
  type CheckpointSaveEvent,
  type ConfigSaveEvent,
} from './config-modal/config-modal.component';
import { DashboardDataService, LIVE_WINDOW_MS } from './dashboard-data.service';
import { HistoryViewComponent, type Costs } from './history-view/history-view.component';
import { LiveViewComponent, type FlowState } from './live-view/live-view.component';
import type { SmaState } from './sma-card/sma-card.component';
import type { WallboxState } from './wallbox-card/wallbox-card.component';

// Surplus (W) from which charging makes sense (~6 A single-phase). Configurable later.
const CHARGE_THRESHOLD_W = 1400;

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [ConfigModalComponent, LiveViewComponent, HistoryViewComponent],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit {
  private readonly data = inject(DashboardDataService);

  readonly appVersion = APP_VERSION;

  // View state (everything data-related lives in DashboardDataService)
  readonly view = signal<View>('live');
  readonly refDate = signal<Date>(new Date());
  readonly configOpen = signal(false);

  // Data signals, re-exposed for the template
  readonly latest = this.data.latest;
  readonly today = this.data.today;
  readonly balance = this.data.balance;
  readonly dataRange = this.data.dataRange;
  readonly tariff = this.data.tariff;
  readonly checkpoints = this.data.checkpoints;
  readonly wallbox = this.data.wallbox;
  readonly wallboxConfig = this.data.wallboxConfig;
  readonly sma = this.data.sma;
  readonly smaConfig = this.data.smaConfig;
  readonly energy = this.data.energy;
  readonly periodBalance = this.data.periodBalance;
  readonly loading = this.data.loading;
  readonly error = this.data.error;

  readonly views: { id: View; label: string }[] = [
    { id: 'live', label: 'Live' },
    { id: 'day', label: 'Tag' },
    { id: 'week', label: 'Woche' },
    { id: 'month', label: 'Monat' },
  ];

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
    const buf = this.data.liveBuffer();
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
    const s = this.data.series();
    const points = s?.points ?? [];
    return signedPowerChart(
      points.map(
        (p) => [p.time, netWatts(p.gridToHomePowerAvg, p.pvToGridPowerAvg)] as [string, number],
      ),
      {
        axisFormat: (v: number) => dayLabel(view, v),
        tickIntervalMs: view === 'week' ? ONE_DAY : view === 'day' ? TWO_HOURS : undefined,
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
    const series: CategorySeries[] = [
      {
        name: 'Bezug',
        color: CHART_COLORS.import,
        data: slots.map((s) => round2(byKey.get(s.key)?.imp ?? 0)),
      },
      {
        name: 'Einspeisung',
        color: CHART_COLORS.export,
        data: slots.map((s) => -round2(byKey.get(s.key)?.exp ?? 0)),
      },
    ];
    // Week: PV production fits as its own (unstacked) bar next to Bezug/Einspeisung.
    // Month has too many day-slots for a third bar - it gets its own chart instead (see pvChart).
    if (view === 'week') {
      const production = this.data.smaDailyEnergy();
      if (production.length > 0) {
        const prodByKey = new Map(production.map((d) => [isoToSlotKey(d.day), d.yieldKwh]));
        series.push({
          name: 'PV-Erzeugung',
          color: CHART_COLORS.production,
          stack: false,
          data: slots.map((s) => round2(prodByKey.get(s.key) ?? 0)),
        });
      }
    }
    return categorySeriesChart(
      slots.map((s) => s.label),
      series,
      { legend: true, stacked: true },
    );
  });

  /** PV production chart: minute-resolution line (day, matching the Leistung
   *  chart's granularity) or daily bar (month). Week shows it merged into
   *  energyChart instead, so this is null there. */
  readonly pvChart = computed<EChartsCoreOption | null>(() => {
    const view = this.view();
    if (view === 'day') {
      // Rendered whenever the PV inverter is enabled - an enabled inverter with
      // no data yet shows a flat zero line rather than the whole section
      // vanishing. Hidden only when the inverter is not enabled.
      if (!this.smaConfig()?.enabled) return null;
      const data = this.data.smaMinutePower();
      // Full minute resolution (1440 slots), matching the Leistung chart.
      const slots = minuteBucketSlots(this.refDate(), 1);
      const byKey = sumByMinuteBucket(data, (d) => d.powerW, 1);
      // 0 W is a real reading (night / no sun), not "no data" - only a slot with
      // no bucket at all (collector was down) renders as a gap.
      return categorySeriesChart(
        slots.map((s) => s.label),
        [
          {
            name: 'PV-Erzeugung',
            color: CHART_COLORS.production,
            type: 'line',
            data: slots.map((s) => byKey.get(s.key) ?? null),
          },
        ],
        // 1440 one-minute slots - force a label every 2h (120 slots) so it
        // lines up with the Leistung chart instead of 'auto' picking an
        // uneven spacing at this density.
        { xAxisLabelInterval: 120 - 1, unit: 'W' },
      );
    }
    if (view === 'month') {
      const data = this.data.smaDailyEnergy();
      if (data.length === 0) return null;
      const slots = energySlots('month', this.refDate());
      const byKey = new Map(data.map((d) => [isoToSlotKey(d.day), d.yieldKwh]));
      return categorySeriesChart(
        slots.map((s) => s.label),
        [
          {
            name: 'PV-Erzeugung',
            color: CHART_COLORS.production,
            data: slots.map((s) => round2(byKey.get(s.key) ?? 0)),
          },
        ],
      );
    }
    return null;
  });

  /** Wallbox charged-energy chart: 5-min line (day) or daily bar (week/month).
   *  Rendered whenever the wallbox is enabled - a wallbox that is offline (no
   *  readings for the period) shows an empty all-zero chart rather than the whole
   *  section vanishing, which looked like a bug. Hidden only when the wallbox is
   *  not enabled at all. */
  readonly wallboxChart = computed<EChartsCoreOption | null>(() => {
    if (!this.wallboxConfig()?.enabled) return null;
    const view = this.view();
    if (view === 'day') {
      const hist = this.data.wallboxHistory();
      const slots = minuteBucketSlots(this.refDate());
      // Charged energy per 5-min bucket from raw readings, replicating the
      // wallbox_1hour aggregate's formula: sum of active power while charging
      // (status 2), over 30-second samples, / 120000 -> kWh. Unlike the PV
      // line, 0 is a real value here (not charging), so every slot is drawn.
      const byKey = sumByMinuteBucket(hist, (r) => (r.status === 2 ? (r.activePowerW ?? 0) : 0));
      return categorySeriesChart(
        slots.map((s) => s.label),
        [
          {
            name: 'Geladen',
            color: CHART_COLORS.charge,
            type: 'line',
            data: slots.map((s) => round2((byKey.get(s.key) ?? 0) / 120000)),
          },
        ],
        // 288 five-minute slots - label every 2h (24 slots), matching the PV line.
        { xAxisLabelInterval: 24 - 1 },
      );
    }
    if (view === 'week' || view === 'month') {
      const data = this.data.wallboxDailyEnergy();
      const slots = energySlots(view, this.refDate());
      const byKey = new Map(data.map((d) => [isoToSlotKey(d.day), d.chargedKwh]));
      return categorySeriesChart(
        slots.map((s) => s.label),
        [
          {
            name: 'Geladen',
            color: CHART_COLORS.charge,
            data: slots.map((s) => round2(byKey.get(s.key) ?? 0)),
          },
        ],
      );
    }
    return null;
  });

  ngOnInit(): void {
    this.data.start();
  }

  openConfig(): void {
    this.configOpen.set(true);
  }

  closeConfig(): void {
    this.configOpen.set(false);
  }

  onConfigSave(event: ConfigSaveEvent): void {
    // Close the modal only when every save succeeded; errors stay visible.
    void this.data.saveConfig(event).then((ok) => {
      if (ok) this.configOpen.set(false);
    });
  }

  onCheckpointSave(event: CheckpointSaveEvent): void {
    this.data.saveCheckpoint(event);
  }

  onCheckpointDelete(id: number): void {
    this.data.deleteCheckpoint(id);
  }

  select(view: View): void {
    this.view.set(view);
    this.refDate.set(new Date());
    if (view === 'live') this.data.clearPeriod();
    else this.data.loadPeriod(view, this.refDate());
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
    this.data.loadPeriod(v, d);
  }
}
