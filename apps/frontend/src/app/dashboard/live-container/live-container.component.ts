import { Component, computed, inject } from '@angular/core';
import { WALLBOX_STATUS_LABELS } from '@org/shared-types';
import { liveSparkChart, netWatts } from '../../core/chart-utils';
import { calibrateBalance, calibrateEnergy } from '../../core/calibration';
import { ClockService } from '../../core/clock.service';
import { DashboardDataService, LIVE_WINDOW_MS } from '../dashboard-data.service';
import { LiveViewComponent, type FlowState } from '../live-view/live-view.component';
import type { SmaState } from '../sma-card/sma-card.component';
import type { WallboxState } from '../wallbox-card/wallbox-card.component';

// Surplus (W) from which charging makes sense (~6 A single-phase). Configurable later.
const CHARGE_THRESHOLD_W = 1400;

/** A reading whose own `time` is older than this many poll intervals is shown
 *  as "veraltet" rather than left looking live - wide enough to absorb normal
 *  jitter around one missed poll. Judged from the reading's own timestamp,
 *  not from when the socket delivered it: a newly connected client gets the
 *  last known DB row immediately (see LiveGateway.handleConnection), which
 *  can itself be hours old if the device has been offline since. */
const STALE_INTERVAL_FACTOR = 3;
const MIN_STALE_MS = 15_000;

/** The smart meter has no configurable interval; the collector polls it at 5s. */
const METER_INTERVAL_S = 5;

function isStale(readingTime: string, pollIntervalS: number, now: number): boolean {
  const threshold = Math.max(pollIntervalS * STALE_INTERVAL_FACTOR * 1000, MIN_STALE_MS);
  return now - new Date(readingTime).getTime() > threshold;
}

@Component({
  selector: 'app-live-container',
  standalone: true,
  imports: [LiveViewComponent],
  template: `
    <app-live-view
      [flow]="flow()"
      [today]="today()"
      [calibrated]="calibrated()"
      [liveSpark]="liveSpark()"
      [wallboxState]="wallboxState()"
      [wallboxName]="wallboxName()"
      [smaState]="smaState()"
      [smaName]="smaName()"
      [balance]="balance()"
    />
  `,
})
export class LiveContainerComponent {
  private readonly data = inject(DashboardDataService);
  private readonly clock = inject(ClockService);

  // Today's Bezug/Einspeisung, corrected onto the physical meter when
  // calibration is on — the same factor the history and admin views use.
  readonly today = computed(() => calibrateEnergy(this.data.today(), this.data.calibration()));
  readonly calibrated = computed(() => this.data.calibration() !== null);
  // Calibrated in lockstep with `today` above, so the SMA card's Autarkie/
  // Eigenverbrauch/Hauslast never disagree with the calibrated Bezug/Einspeisung.
  readonly balance = computed(() => calibrateBalance(this.data.balance(), this.data.calibration()));

  readonly wallboxName = computed(() => this.data.wallboxConfig()?.name?.trim() || 'Wallbox');

  readonly smaName = computed(() => this.data.smaConfig()?.name?.trim() || 'PV-Anlage');

  readonly smaState = computed<SmaState | null>(() => {
    if (this.data.smaConfig()?.enabled === false) return null;
    const s = this.data.sma();
    if (!s) return null;
    return {
      productionW: s.gridPower ?? 0,
      dailyYieldKwh: (s.dailyYieldWh ?? 0) / 1000,
      asleep: s.asleep,
      stale: isStale(s.time, this.data.smaConfig()?.pollIntervalS ?? 60, this.clock.now()),
    };
  });

  readonly wallboxState = computed<WallboxState | null>(() => {
    if (this.data.wallboxConfig()?.enabled === false) return null;
    const w = this.data.wallbox();
    if (!w) return null;
    const status = w.status ?? 0;
    return {
      statusLabel: WALLBOX_STATUS_LABELS[status] ?? `Status ${status}`,
      charging: status === 2,
      powerW: w.activePowerW ?? 0,
      sessionKwh: (w.sessionEnergyWh ?? 0) / 1000,
      stale: isStale(w.time, this.data.wallboxConfig()?.pollIntervalS ?? 30, this.clock.now()),
    };
  });

  /**
   * The hero figure. Stale-checked like the two device cards: the smart meter
   * is the device under the single-MQTT-session limit and so the likeliest to
   * go quiet, and a frozen headline number with no cue is the most misleading
   * thing the dashboard can show.
   */
  readonly flow = computed<FlowState>(() => {
    const r = this.data.latest();
    const stale = r !== null && isStale(r.time, METER_INTERVAL_S, this.clock.now());
    const imp = r?.gridToHomePower ?? 0;
    const exp = r?.pvToGridPower ?? 0;
    if (exp > 0) {
      return { mode: 'export', watts: exp, charging: exp >= CHARGE_THRESHOLD_W, stale };
    }
    if (imp > 0) return { mode: 'import', watts: imp, charging: false, stale };
    return { mode: 'idle', watts: 0, charging: false, stale };
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

  constructor() {
    // Entering the live view: drop any history-period data still held in the
    // service (and invalidate in-flight period requests) so a later switch back
    // to a history tab starts clean instead of flashing stale charts.
    this.data.clearPeriod();
  }
}
