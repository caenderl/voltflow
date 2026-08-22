import { Injectable, type WritableSignal, computed, inject, signal } from '@angular/core';
import { Observable, catchError, firstValueFrom, map, of } from 'rxjs';
import type {
  AppSettings,
  DataRange,
  EnergyBalance,
  EnergySummary,
  MeterCheckpoint,
  MeterReading,
  MeterReconciliation,
  SeriesResponse,
  SmaDailySummary,
  SmaMinutePower,
  SmaReading,
  TariffPeriod,
  WallboxDailySummary,
  WallboxReading,
} from '@org/shared-types';
import { appendWindowed } from '../core/chart-utils';
import type { CalibrationFactors } from '../core/calibration';
import { type View, rangeFor, startOfDay } from '../core/date-utils';
import { DeviceRegistryService } from '../core/device-registry.service';
import { LiveService } from '../core/live.service';
import { MeterApiService } from '../core/meter-api.service';
import { SettingsApiService } from '../core/settings-api.service';
import { EnergyApiService } from '../core/energy-api.service';
import { SmaApiService } from '../core/sma-api.service';
import { WallboxApiService } from '../core/wallbox-api.service';
import type { CheckpointSaveEvent, TariffPeriodSaveEvent } from '../core/config-types';

export interface LivePoint {
  time: string;
  grid: number | null;
  pv: number | null;
}

/** Rolling window shown in the live hero chart. */
export const LIVE_WINDOW_MIN = 10;
export const LIVE_WINDOW_MS = LIVE_WINDOW_MIN * 60 * 1000;

const TODAY_REFRESH_MS = 5 * 60 * 1000;
/** At most one live resync per this interval, so flipping between tabs cannot
 *  turn into a request per switch. */
const RESUME_THROTTLE_MS = 30 * 1000;
const LOAD_ERROR = 'Daten konnten nicht geladen werden (Backend erreichbar?).';

/**
 * Dashboard state + loading: exposes all data as signals, talks to the REST
 * APIs and the live WebSocket. Root-provided, so live subscriptions and the
 * refresh interval share the app's lifetime (no per-component teardown).
 * The Dashboard component keeps only view state and chart derivation.
 */
@Injectable({ providedIn: 'root' })
export class DashboardDataService {
  private readonly live = inject(LiveService);
  private readonly meterApi = inject(MeterApiService);
  private readonly wallboxApi = inject(WallboxApiService);
  private readonly smaApi = inject(SmaApiService);
  private readonly energyApi = inject(EnergyApiService);
  private readonly settingsApi = inject(SettingsApiService);
  private readonly registry = inject(DeviceRegistryService);

  // Live readings (WebSocket), keyed by device serial for the kinds that can
  // have several instances. The gateway sends one message per device on
  // connect and one per reading after that, each naming its own `deviceSn`.
  readonly wallboxBySn = signal<ReadonlyMap<string, WallboxReading>>(new Map());
  readonly smaBySn = signal<ReadonlyMap<string, SmaReading>>(new Map());
  /**
   * The grid meter stays singular: it is the house connection point, of which
   * there is one by definition, and the hero figure is a site-level number. A
   * second grid meter would have to be *summed* into it, not picked between,
   * so a map here would only make the wrong thing look supported.
   */
  readonly latest = signal<MeterReading | null>(null);
  readonly liveBuffer = signal<LivePoint[]>([]);

  // Today (live view), refreshed periodically
  readonly today = signal<EnergySummary | null>(null);
  /** Today's balance for the live SMA card. */
  readonly balance = signal<EnergyBalance | null>(null);

  // Configuration
  readonly dataRange = signal<DataRange | null>(null);
  readonly tariffPeriods = signal<TariffPeriod[]>([]);
  readonly appSettings = signal<AppSettings | null>(null);
  readonly checkpoints = signal<MeterCheckpoint[]>([]);
  /** Checkpoints vs. smart meter, recomputed whenever a checkpoint changes. */
  readonly reconciliation = signal<MeterReconciliation | null>(null);

  /**
   * Active calibration factors, or null when calibration is off or there is no
   * comparable checkpoint pair to derive them from. Single source of truth so
   * every view calibrates identically — pass it to `calibrateEnergy`.
   */
  readonly calibration = computed<CalibrationFactors | null>(() => {
    if (!this.appSettings()?.calibrationEnabled) return null;
    const t = this.reconciliation()?.totals;
    if (!t || t.importFactor === null || t.exportFactor === null) return null;
    return { importFactor: t.importFactor, exportFactor: t.exportFactor };
  });

  // Selected history period (day/week/month)
  readonly series = signal<SeriesResponse | null>(null);
  readonly energy = signal<EnergySummary | null>(null);
  /** Balance for the selected history period. */
  readonly periodBalance = signal<EnergyBalance | null>(null);
  readonly wallboxDailyEnergy = signal<WallboxDailySummary[]>([]);
  readonly wallboxHistory = signal<WallboxReading[]>([]);
  readonly smaDailyEnergy = signal<SmaDailySummary[]>([]);
  readonly smaMinutePower = signal<SmaMinutePower[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  private started = false;
  /** When the live window was last (re)fetched — see resumeLive's throttle. */
  private lastLiveSync = 0;

  /** Connect live streams and load the initial data. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.backfillLive();
    this.live.readings$().subscribe((r) => {
      this.latest.set(r);
      this.liveBuffer.set(
        appendWindowed(
          this.liveBuffer(),
          [{ time: r.time, grid: r.gridToHomePower, pv: r.pvToGridPower }],
          LIVE_WINDOW_MS,
        ),
      );
    });
    this.live.wallboxReadings$().subscribe((w) => upsertBySn(this.wallboxBySn, w));
    this.live.smaReadings$().subscribe((s) => upsertBySn(this.smaBySn, s));
    this.live.reconnects$().subscribe(() => this.resumeLive());
    // A backgrounded tab / PWA is suspended without the socket necessarily
    // dropping, so becoming visible again is its own resume trigger.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.resumeLive();
    });

    this.loadInto(this.meterApi.range(), (r) => this.dataRange.set(r));
    this.loadTariffPeriods();
    this.loadInto(this.settingsApi.appSettings(), (s) => this.appSettings.set(s));
    // Device state lives in its own service; this is just the one place the
    // app's initial load is triggered from.
    this.registry.load();
    this.loadCheckpoints();

    this.loadToday();
    // Root service = app lifetime; the interval intentionally never stops.
    setInterval(() => this.loadToday(), TODAY_REFRESH_MS);
  }

  /** Generation counter for period loads: a response only writes its signal
   *  while it still belongs to the latest loadPeriod/clearPeriod. Without it,
   *  a slow response for the PREVIOUS period lands after the new period's
   *  up-front clear and repopulates the charts with the wrong period's data
   *  (day-view hour keys are date-independent, so it would render as if it
   *  belonged to the selected day). */
  private periodSeq = 0;

  /** Load series/energy/balance for a history period ([from, to) via rangeFor). */
  loadPeriod(view: View, refDate: Date): void {
    const { from, to, resolution, period, date } = rangeFor(view, refDate);
    const seq = ++this.periodSeq;
    const current = () => seq === this.periodSeq;
    this.loading.set(true);
    this.error.set(null);
    this.series.set(null);
    this.energy.set(null);
    this.periodBalance.set(null);
    // Clear all period-energy signals up front so a chart never renders the
    // previous period's data mapped onto the new slots while the refetch is in
    // flight (hourly keys are date-independent, so stale data would collide).
    this.wallboxDailyEnergy.set([]);
    this.wallboxHistory.set([]);
    this.smaDailyEnergy.set([]);
    this.smaMinutePower.set([]);
    this.energyApi.balance(from, to).subscribe({
      next: (b) => current() && this.periodBalance.set(b),
      error: () => current() && this.periodBalance.set(null),
    });
    this.meterApi.series(from, to, resolution).subscribe({
      next: (s) => current() && this.series.set(s),
      complete: () => current() && this.loading.set(false),
      error: () => {
        if (!current()) return;
        this.loading.set(false);
        this.error.set(LOAD_ERROR);
      },
    });
    this.meterApi.energy(period, date).subscribe({
      next: (e) => current() && this.energy.set(e),
      error: () => current() && this.error.set(LOAD_ERROR),
    });
    if (view === 'week' || view === 'month') {
      this.wallboxApi.dailyEnergy(from, to).subscribe({
        next: (d) => current() && this.wallboxDailyEnergy.set(d),
        error: () => current() && this.wallboxDailyEnergy.set([]),
      });
      this.smaApi.dailyEnergy(from, to).subscribe({
        next: (d) => current() && this.smaDailyEnergy.set(d),
        error: () => current() && this.smaDailyEnergy.set([]),
      });
    } else {
      this.wallboxApi.history(from, to).subscribe({
        next: (d) => current() && this.wallboxHistory.set(d),
        error: () => current() && this.wallboxHistory.set([]),
      });
      this.smaApi.minutePower(from, to).subscribe({
        next: (d) => current() && this.smaMinutePower.set(d),
        error: () => current() && this.smaMinutePower.set([]),
      });
    }
  }

  /** Reset the history-period state (when switching to the live view). */
  clearPeriod(): void {
    this.periodSeq++; // invalidate any in-flight period requests
    this.wallboxDailyEnergy.set([]);
    this.wallboxHistory.set([]);
    this.smaDailyEnergy.set([]);
    this.smaMinutePower.set([]);
    this.periodBalance.set(null);
  }

  /** Resolves true once the display settings have actually been saved. */
  saveConfig(appSettings: AppSettings): Promise<boolean> {
    this.error.set(null);
    return firstValueFrom(
      this.settingsApi.saveAppSettings(appSettings).pipe(
        map((saved) => {
          this.appSettings.set(saved);
          return true;
        }),
        catchError(() => {
          this.error.set('Anzeige-Einstellungen konnten nicht gespeichert werden.');
          return of(false);
        }),
      ),
    );
  }

  /**
   * Resolves true only once the save has actually landed, so callers can defer
   * resetting their form until success instead of clearing it out from under a
   * rejected (e.g. 409) attempt.
   */
  saveCheckpoint(event: CheckpointSaveEvent): Promise<boolean> {
    const input = {
      date: event.date,
      readAt: event.readAt,
      importKwh: event.importKwh,
      exportKwh: event.exportKwh,
    };
    const obs =
      event.id === undefined
        ? this.settingsApi.createMeterCheckpoint(input)
        : this.settingsApi.updateMeterCheckpoint(event.id, input);
    // Drop a previous failure up front, so the message on screen always belongs
    // to the attempt the user just made.
    this.error.set(null);
    return firstValueFrom(
      obs.pipe(
        map(() => {
          this.loadCheckpoints();
          return true;
        }),
        // 409 = there is already a checkpoint for that date; naming the cause
        // beats a generic failure the user cannot act on.
        catchError((err: { status?: number }) => {
          this.error.set(
            err?.status === 409
              ? 'Für dieses Datum gibt es bereits einen Zählerstand — bitte den vorhandenen bearbeiten.'
              : 'Zählerstand konnte nicht gespeichert werden.',
          );
          return of(false);
        }),
      ),
    );
  }

  deleteCheckpoint(id: number): void {
    this.error.set(null);
    this.settingsApi.deleteMeterCheckpoint(id).subscribe({
      next: () => {
        this.checkpoints.set(this.checkpoints().filter((c) => c.id !== id));
        this.loadCheckpoints();
      },
      error: () => this.error.set('Zählerstand konnte nicht gelöscht werden.'),
    });
  }

  /**
   * Resolves true only once the save has actually landed, so callers can defer
   * resetting their form until success instead of clearing it out from under a
   * rejected (e.g. 409) attempt.
   */
  saveTariffPeriod(event: TariffPeriodSaveEvent): Promise<boolean> {
    const input = {
      validFrom: event.validFrom,
      provider: event.provider,
      importCtPerKwh: event.importCtPerKwh,
      exportCtPerKwh: event.exportCtPerKwh,
      baseEurPerYear: event.baseEurPerYear,
    };
    const obs =
      event.id === undefined
        ? this.settingsApi.createTariffPeriod(input)
        : this.settingsApi.updateTariffPeriod(event.id, input);
    this.error.set(null);
    return firstValueFrom(
      obs.pipe(
        map(() => {
          this.loadTariffPeriods();
          return true;
        }),
        // 409 = there is already a tariff for that start date; naming the cause
        // beats a generic failure the user cannot act on.
        catchError((err: { status?: number }) => {
          this.error.set(
            err?.status === 409
              ? 'Für dieses Startdatum gibt es bereits einen Tarif — bitte den vorhandenen bearbeiten.'
              : 'Tarif konnte nicht gespeichert werden.',
          );
          return of(false);
        }),
      ),
    );
  }

  deleteTariffPeriod(id: number): void {
    this.error.set(null);
    this.settingsApi.deleteTariffPeriod(id).subscribe({
      next: () => {
        this.tariffPeriods.set(this.tariffPeriods().filter((p) => p.id !== id));
        this.loadTariffPeriods();
      },
      error: () => this.error.set('Tarif konnte nicht gelöscht werden.'),
    });
  }

  /** Reload the tariff periods used for the cost calculation. */
  private loadTariffPeriods(): void {
    this.loadInto(this.settingsApi.tariffPeriods(), (p) => this.tariffPeriods.set(p));
  }

  /** Subscribe, write into a setter, silently ignore errors (optional data). */
  private loadInto<T>(obs: Observable<T>, apply: (v: T) => void): void {
    obs.subscribe({ next: apply, error: () => undefined });
  }

  /** Reload the checkpoint list and the derived smart meter comparison. */
  private loadCheckpoints(): void {
    this.loadInto(this.settingsApi.meterCheckpoints(), (c) => this.checkpoints.set(c));
    this.loadInto(this.settingsApi.meterReconciliation(), (r) => this.reconciliation.set(r));
  }

  private loadToday(): void {
    this.loadInto(this.meterApi.energy('day', new Date()), (e) => this.today.set(e));
    // Today's energy balance (self-consumption / autarky) for the live SMA card.
    this.loadInto(this.energyApi.balance(startOfDay(new Date()), new Date()), (b) =>
      this.balance.set(b),
    );
  }

  /**
   * Resync after a gap in the live stream (app was in the background, socket
   * dropped). No readings arrive while suspended, and `appendWindowed` trims
   * the buffer relative to its NEWEST point — so the first reading after the
   * gap (the gateway emits one on every connect) drops everything older than
   * the window around it and the hero chart collapses to a sliver at the right
   * edge until it slowly refills. Refetching the window restores it at once.
   *
   * Deliberately not conditional on how stale the buffer looks: the gateway
   * emits the latest reading to every connecting client, and if that lands
   * before this runs the buffer would look perfectly fresh while being exactly
   * one point wide. Only a throttle guards it.
   */
  private resumeLive(): void {
    if (Date.now() - this.lastLiveSync < RESUME_THROTTLE_MS) return;
    this.backfillLive();
    // The refresh interval is throttled/frozen while suspended too, so today's
    // Bezug/Einspeisung can be just as stale as the chart.
    this.loadToday();
  }

  /** Seed the live buffers with the last window of data so the hero chart is
   *  populated immediately instead of filling up over time. */
  private backfillLive(): void {
    this.lastLiveSync = Date.now();
    const to = new Date();
    const from = new Date(to.getTime() - LIVE_WINDOW_MS);
    this.loadInto(this.meterApi.series(from, to, 'raw'), (s) => {
      const points = s.points.map((p) => ({
        time: p.time,
        grid: p.gridToHomePowerAvg,
        pv: p.pvToGridPowerAvg,
      }));
      this.liveBuffer.set(appendWindowed(this.liveBuffer(), points, LIVE_WINDOW_MS));
    });
  }
}

/**
 * Replace one device's entry in a by-serial map. A new Map each time, because a
 * signal holding a mutated Map is the same object and would notify nobody.
 */
function upsertBySn<T extends { deviceSn: string }>(
  target: WritableSignal<ReadonlyMap<string, T>>,
  reading: T,
): void {
  const next = new Map(target());
  next.set(reading.deviceSn, reading);
  target.set(next);
}
