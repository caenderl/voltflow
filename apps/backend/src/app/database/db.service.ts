import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Client, Pool } from 'pg';
import { Subject } from 'rxjs';
import type { MeterReading, SmaReading, WallboxReading } from '@org/shared-types';
import { applyMigrations } from './schema';

const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

/** Converts a DB row (snake_case) into a MeterReading. */
export function rowToReading(row: Record<string, unknown>): MeterReading {
  return {
    time: new Date(row['time'] as string).toISOString(),
    deviceSn: row['device_sn'] as string,
    gridToHomePower: num(row['grid_to_home_power']),
    pvToGridPower: num(row['pv_to_grid_power']),
    gridImportEnergy: num(row['grid_import_energy']),
    gridExportEnergy: num(row['grid_export_energy']),
  };
}

/** Converts a DB row (snake_case) into a WallboxReading. */
export function rowToWallboxReading(
  row: Record<string, unknown>,
): WallboxReading {
  return {
    time: new Date(row['time'] as string).toISOString(),
    deviceSn: row['device_sn'] as string,
    status: num(row['status']),
    cpSignal: num(row['cp_signal']),
    activePowerW: num(row['active_power_w']),
    sessionEnergyWh: num(row['session_energy_wh']),
    sessionDurationS: num(row['session_duration_s']),
    l1CurrentA: num(row['l1_current_a']),
    l2CurrentA: num(row['l2_current_a']),
    l3CurrentA: num(row['l3_current_a']),
    l1VoltageV: num(row['l1_voltage_v']),
    l2VoltageV: num(row['l2_voltage_v']),
    l3VoltageV: num(row['l3_voltage_v']),
  };
}

/** Converts a DB row (snake_case) into an SmaReading. */
export function rowToSmaReading(row: Record<string, unknown>): SmaReading {
  return {
    time: new Date(row['time'] as string).toISOString(),
    deviceSn: row['device_sn'] as string,
    asleep: Boolean(row['asleep']),
    gridPower: num(row['grid_power']),
    pvPowerA: num(row['pv_power_a']),
    pvPowerB: num(row['pv_power_b']),
    dailyYieldWh: num(row['daily_yield_wh']),
    totalYieldKwh: num(row['total_yield_kwh']),
    powerL1: num(row['power_l1']),
    powerL2: num(row['power_l2']),
    powerL3: num(row['power_l3']),
    pvVoltageA: num(row['pv_voltage_a']),
    pvVoltageB: num(row['pv_voltage_b']),
    pvCurrentA: num(row['pv_current_a']),
    pvCurrentB: num(row['pv_current_b']),
    voltageL1: num(row['voltage_l1']),
    voltageL2: num(row['voltage_l2']),
    voltageL3: num(row['voltage_l3']),
    frequency: num(row['frequency']),
    tempA: num(row['temp_a']),
    status: num(row['status']),
  };
}

const LISTEN_RECONNECT_MS = 5000;

/**
 * Encapsulates Postgres access:
 *  - a pool for regular queries
 *  - a dedicated client with LISTEN meter_reading for the live push
 */
@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private dsn!: string;
  private pool!: Pool;
  private listenClient: Client | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** Stream of new meter readings (fed by pg NOTIFY). */
  readonly readings$ = new Subject<MeterReading>();
  /** Stream of new wallbox readings (fed by pg NOTIFY). */
  readonly wallboxReadings$ = new Subject<WallboxReading>();
  /** Stream of new SMA inverter readings (fed by pg NOTIFY). */
  readonly smaReadings$ = new Subject<SmaReading>();

  onModuleInit(): void {
    const dsn = process.env.DATABASE_URL;
    if (!dsn) {
      // Configuration error -> fail hard (no meaningful operation possible)
      throw new Error('DATABASE_URL not set (env or .env).');
    }
    this.dsn = dsn;
    // Pool for REST queries: connects lazily and reconnects per query itself.
    this.pool = new Pool({ connectionString: dsn });
    this.pool.on('error', (err) =>
      this.logger.error(`DB pool error: ${err.message}`),
    );
    // Apply idempotent schema migrations (also catches up pre-existing DBs)
    void applyMigrations(this.pool, this.logger);
    // LISTEN client for the live push: separate, with auto-reconnect.
    void this.connectListener();
  }

  /** Set up the dedicated LISTEN client; reconnect automatically on failure. */
  private async connectListener(): Promise<void> {
    if (this.stopped) return;
    const client = new Client({ connectionString: this.dsn });
    client.on('notification', (msg) => {
      if (!msg.payload) return;
      try {
        const row = JSON.parse(msg.payload) as Record<string, unknown>;
        if (msg.channel === 'wallbox_reading') {
          this.wallboxReadings$.next(rowToWallboxReading(row));
        } else if (msg.channel === 'sma_reading') {
          this.smaReadings$.next(rowToSmaReading(row));
        } else {
          this.readings$.next(rowToReading(row));
        }
      } catch (err) {
        this.logger.warn(`Could not parse NOTIFY payload: ${err}`);
      }
    });
    // error/end -> connection is considered dead, schedule a reconnect
    client.on('error', (err) => {
      this.logger.error(`LISTEN client error: ${err.message}`);
      this.handleListenFailure(client);
    });
    client.on('end', () => this.handleListenFailure(client));

    try {
      await client.connect();
      await client.query('LISTEN meter_reading');
      await client.query('LISTEN wallbox_reading');
      await client.query('LISTEN sma_reading');
      this.listenClient = client;
      this.logger.log('LISTEN meter_reading + wallbox_reading + sma_reading active');
    } catch (err) {
      this.logger.warn(
        `LISTEN connection failed, retrying in ${LISTEN_RECONNECT_MS}ms: ${err}`,
      );
      this.handleListenFailure(client);
    }
  }

  /** Neutralize the dead client and schedule a (single) reconnect. */
  private handleListenFailure(client: Client): void {
    if (this.stopped) return;
    // Remove the dead client's handlers, but keep a no-op error handler so that
    // late 'error' events do not crash the process as unhandled.
    client.removeAllListeners();
    client.on('error', () => undefined);
    void client.end().catch(() => undefined);
    if (this.listenClient === client) this.listenClient = null;

    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectListener();
    }, LISTEN_RECONNECT_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.listenClient?.end().catch(() => undefined);
    await this.pool?.end().catch(() => undefined);
  }

  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> {
    return this.pool.query(text, params) as Promise<{ rows: T[] }>;
  }
}
