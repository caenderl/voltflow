import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, firstValueFrom, forkJoin, map, of } from 'rxjs';
import type {
  DataRange,
  EnergyBalance,
  EnergySummary,
  MeterCheckpoint,
  MeterReading,
  SeriesResponse,
  SmaConfig,
  SmaDailySummary,
  SmaMinutePower,
  SmaReading,
  Tariff,
  WallboxConfig,
  WallboxDailySummary,
  WallboxReading,
} from '@org/shared-types';
import { appendWindowed } from '../core/chart-utils';
import { type View, rangeFor, startOfDay } from '../core/date-utils';
import { LiveService } from '../core/live.service';
import { MeterApiService } from '../core/meter-api.service';
import { SettingsApiService } from '../core/settings-api.service';
import { SmaApiService } from '../core/sma-api.service';
import { WallboxApiService } from '../core/wallbox-api.service';
import type {
  CheckpointSaveEvent,
  ConfigSaveEvent,
} from './config-modal/config-modal.component';

export interface LivePoint {
  time: string;
  grid: number | null;
  pv: number | null;
}

/** Rolling window shown in the live hero chart. */
export const LIVE_WINDOW_MIN = 10;
export const LIVE_WINDOW_MS = LIVE_WINDOW_MIN * 60 * 1000;

const TODAY_REFRESH_MS = 5 * 60 * 1000;
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
  private readonly settingsApi = inject(SettingsApiService);

  // Live readings (WebSocket)
  readonly latest = signal<MeterReading | null>(null);
  readonly wallbox = signal<WallboxReading | null>(null);
  readonly sma = signal<SmaReading | null>(null);
  readonly liveBuffer = signal<LivePoint[]>([]);

  // Today (live view), refreshed periodically
  readonly today = signal<EnergySummary | null>(null);
  /** Today's balance for the live SMA card. */
  readonly balance = signal<EnergyBalance | null>(null);

  // Configuration
  readonly dataRange = signal<DataRange | null>(null);
  readonly tariff = signal<Tariff | null>(null);
  readonly wallboxConfig = signal<WallboxConfig | null>(null);
  readonly smaConfig = signal<SmaConfig | null>(null);
  readonly checkpoints = signal<MeterCheckpoint[]>([]);

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
    this.live.wallboxReadings$().subscribe((w) => this.wallbox.set(w));
    this.live.smaReadings$().subscribe((s) => this.sma.set(s));

    this.loadInto(this.meterApi.range(), (r) => this.dataRange.set(r));
    this.loadInto(this.settingsApi.tariff(), (t) => this.tariff.set(t));
    this.loadInto(this.wallboxApi.config(), (c) => this.wallboxConfig.set(c));
    this.loadInto(this.smaApi.config(), (c) => this.smaConfig.set(c));
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
    this.smaApi.balance(from, to).subscribe({
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

  /**
   * Save all three configs in parallel. Resolves true only if every save
   * succeeded (callers keep the modal open otherwise); failures set `error`.
   */
  saveConfig(event: ConfigSaveEvent): Promise<boolean> {
    const attempt = <T>(obs: Observable<T>, apply: (v: T) => void, msg: string) =>
      obs.pipe(
        map((v) => {
          apply(v);
          return true;
        }),
        catchError(() => {
          this.error.set(msg);
          return of(false);
        }),
      );
    return firstValueFrom(
      forkJoin([
        attempt(
          this.wallboxApi.saveConfig(event.wallbox),
          (saved) => this.wallboxConfig.set(saved),
          'Wallbox-Konfiguration konnte nicht gespeichert werden.',
        ),
        attempt(
          this.smaApi.saveConfig(event.sma),
          (saved) => this.smaConfig.set(saved),
          'SMA-Konfiguration konnte nicht gespeichert werden.',
        ),
        attempt(
          this.settingsApi.saveTariff(event.tariff),
          (saved) => this.tariff.set(saved),
          'Tarif konnte nicht gespeichert werden.',
        ),
      ]).pipe(map((results) => results.every(Boolean))),
    );
  }

  saveCheckpoint(event: CheckpointSaveEvent): void {
    const input = { date: event.date, importKwh: event.importKwh, exportKwh: event.exportKwh };
    const obs =
      event.id === undefined
        ? this.settingsApi.createMeterCheckpoint(input)
        : this.settingsApi.updateMeterCheckpoint(event.id, input);
    obs.subscribe({
      next: () => this.loadCheckpoints(),
      error: () => this.error.set('Zählerstand konnte nicht gespeichert werden.'),
    });
  }

  deleteCheckpoint(id: number): void {
    this.settingsApi.deleteMeterCheckpoint(id).subscribe({
      next: () => this.checkpoints.set(this.checkpoints().filter((c) => c.id !== id)),
      error: () => this.error.set('Zählerstand konnte nicht gelöscht werden.'),
    });
  }

  /** Subscribe, write into a setter, silently ignore errors (optional data). */
  private loadInto<T>(obs: Observable<T>, apply: (v: T) => void): void {
    obs.subscribe({ next: apply, error: () => undefined });
  }

  private loadCheckpoints(): void {
    this.loadInto(this.settingsApi.meterCheckpoints(), (c) => this.checkpoints.set(c));
  }

  private loadToday(): void {
    this.loadInto(this.meterApi.energy('day', new Date()), (e) => this.today.set(e));
    // Today's energy balance (self-consumption / autarky) for the live SMA card.
    this.loadInto(this.smaApi.balance(startOfDay(new Date()), new Date()), (b) =>
      this.balance.set(b),
    );
  }

  /** Seed the live buffers with the last window of data so the hero chart is
   *  populated immediately instead of filling up over time. */
  private backfillLive(): void {
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
