import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import type { EChartsCoreOption } from 'echarts/core';
import { filter } from 'rxjs';
import {
  CHART_COLORS,
  ONE_DAY,
  TWO_HOURS,
  type CategorySeries,
  categorySeriesChart,
  energySlots,
  minuteBucketSlots,
  isoToSlotKey,
  netWatts,
  round2,
  signedPowerChart,
  slotKey,
  sumByMinuteBucket,
} from '../../core/chart-utils';
import { type View, dayLabel, periodLabelFor, rangeFor, startOfDay } from '../../core/date-utils';
import { DashboardDataService } from '../dashboard-data.service';
import { HistoryViewComponent } from '../history-view/history-view.component';
import { type Costs } from '../history-summary/history-summary.component';

@Component({
  selector: 'app-history-container',
  standalone: true,
  imports: [HistoryViewComponent],
  template: `
    <app-history-view
      [view]="view()"
      [periodLabel]="periodLabel()"
      [canPrev]="canPrev()"
      [canNext]="canNext()"
      [energy]="energy()"
      [hasTariff]="hasTariff()"
      [costs]="costs()"
      [balance]="periodBalance()"
      [loading]="loading()"
      [error]="error()"
      [powerChart]="powerChart()"
      [energyChart]="energyChart()"
      [pvChart]="pvChart()"
      [wallboxChart]="wallboxChart()"
      (prevClicked)="prev()"
      (nextClicked)="next()"
    />
  `,
})
export class HistoryContainerComponent {
  private readonly data = inject(DashboardDataService);
  private readonly router = inject(Router);

  // Bound from the route's `data: { view }` via withComponentInputBinding().
  readonly view = input.required<View>();

  readonly refDate = signal<Date>(new Date());

  readonly energy = this.data.energy;
  readonly periodBalance = this.data.periodBalance;
  readonly loading = this.data.loading;
  readonly error = this.data.error;

  readonly hasTariff = computed(() => {
    const t = this.data.tariff();
    return t != null && t.importCtPerKwh != null && t.exportCtPerKwh != null;
  });

  readonly costs = computed<Costs | null>(() => {
    const t = this.data.tariff();
    const e = this.data.energy();
    if (!t || !e || t.importCtPerKwh == null || t.exportCtPerKwh == null) return null;
    const importCost = (e.importKwh * t.importCtPerKwh) / 100;
    const exportRevenue = (e.exportKwh * t.exportCtPerKwh) / 100;
    return { importCost, exportRevenue, net: importCost - exportRevenue };
  });

  readonly periodLabel = computed(() => periodLabelFor(this.view(), this.refDate()));

  readonly canPrev = computed(() => {
    const r = this.data.dataRange();
    if (!r?.first) return false;
    const { from } = rangeFor(this.view(), this.refDate());
    return new Date(r.first) < from;
  });

  readonly canNext = computed(() => {
    const { to } = rangeFor(this.view(), this.refDate());
    return to <= startOfDay(new Date());
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
    const buckets = this.data.energy()?.buckets ?? [];
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
      if (!this.data.smaConfig()?.enabled) return null;
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
    if (!this.data.wallboxConfig()?.enabled) return null;
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

  constructor() {
    // Load - and reset to "today" - whenever the active view changes: the first
    // activation (including a hard refresh / deep link) and switching between
    // history tabs. Driven by the `view` input signal rather than router events
    // so the initial load is reliable: on a fresh page load the router's initial
    // NavigationEnd is emitted while this component is being activated, before
    // this constructor's subscription exists, so a refresh on /day would never
    // load if we depended on it (router.events has no replay).
    effect(() => this.loadNow(this.view()));

    // Re-clicking the already-active tab keeps the same instance and the same
    // view input, so the effect above does not fire. With
    // onSameUrlNavigation:'reload' the router still emits a NavigationEnd for the
    // unchanged URL; detect that (url identical to the previous navigation's) to
    // jump back to today. Guarded this way it never double-loads alongside the
    // effect, which handles every genuine view change.
    let lastUrl: string | null = null;
    this.router.events
      .pipe(
        filter((e): e is NavigationEnd => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe((e) => {
        if (e.urlAfterRedirects === lastUrl) this.loadNow(this.view());
        lastUrl = e.urlAfterRedirects;
      });
  }

  /** Reset refDate to now and load that period. */
  private loadNow(view: View): void {
    const d = new Date();
    this.refDate.set(d);
    this.data.loadPeriod(view, d);
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
