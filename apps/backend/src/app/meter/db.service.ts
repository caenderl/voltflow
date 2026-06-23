import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Client, Pool } from 'pg';
import { Subject } from 'rxjs';
import type { MeterReading } from '@org/shared-types';

/** Wandelt eine DB-Zeile (snake_case) in einen MeterReading um. */
export function rowToReading(row: Record<string, unknown>): MeterReading {
  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  return {
    time: new Date(row['time'] as string).toISOString(),
    deviceSn: row['device_sn'] as string,
    gridToHomePower: num(row['grid_to_home_power']),
    pvToGridPower: num(row['pv_to_grid_power']),
    gridImportEnergy: num(row['grid_import_energy']),
    gridExportEnergy: num(row['grid_export_energy']),
  };
}

/**
 * Kapselt den Postgres-Zugriff:
 *  - ein Pool für normale Queries
 *  - ein dedizierter Client mit LISTEN meter_reading für den Live-Push
 */
const LISTEN_RECONNECT_MS = 5000;

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private dsn!: string;
  private pool!: Pool;
  private listenClient: Client | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** Stream neuer Messwerte (gespeist aus pg NOTIFY). */
  readonly readings$ = new Subject<MeterReading>();

  onModuleInit(): void {
    const dsn = process.env.DATABASE_URL;
    if (!dsn) {
      // Konfigurationsfehler -> hart abbrechen (kein sinnvoller Betrieb möglich)
      throw new Error('DATABASE_URL nicht gesetzt (env oder .env).');
    }
    this.dsn = dsn;
    // Pool für REST-Queries: verbindet lazy und reconnectet pro Query selbst.
    this.pool = new Pool({ connectionString: dsn });
    this.pool.on('error', (err) =>
      this.logger.error(`DB-Pool-Fehler: ${err.message}`),
    );
    // LISTEN-Client für den Live-Push: separat, mit Auto-Reconnect.
    void this.connectListener();
  }

  /** Dedizierten LISTEN-Client aufbauen; bei Abbruch automatisch neu verbinden. */
  private async connectListener(): Promise<void> {
    if (this.stopped) return;
    const client = new Client({ connectionString: this.dsn });
    client.on('notification', (msg) => {
      if (!msg.payload) return;
      try {
        const row = JSON.parse(msg.payload) as Record<string, unknown>;
        this.readings$.next(rowToReading(row));
      } catch (err) {
        this.logger.warn(`Konnte NOTIFY-Payload nicht parsen: ${err}`);
      }
    });
    // error/end -> Verbindung gilt als tot, Reconnect planen
    client.on('error', (err) => {
      this.logger.error(`LISTEN-Client-Fehler: ${err.message}`);
      this.handleListenFailure(client);
    });
    client.on('end', () => this.handleListenFailure(client));

    try {
      await client.connect();
      await client.query('LISTEN meter_reading');
      this.listenClient = client;
      this.logger.log('LISTEN meter_reading aktiv');
    } catch (err) {
      this.logger.warn(
        `LISTEN-Verbindung fehlgeschlagen, neuer Versuch in ${LISTEN_RECONNECT_MS}ms: ${err}`,
      );
      this.handleListenFailure(client);
    }
  }

  /** Toten Client neutralisieren und (einmalig) Reconnect planen. */
  private handleListenFailure(client: Client): void {
    if (this.stopped) return;
    // Handler des toten Clients entfernen, aber einen No-op-Error-Handler
    // behalten, damit späte 'error'-Events nicht als unhandled den Prozess killen.
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
