import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Client, Pool } from 'pg';
import { Subject } from 'rxjs';
import type { MeterReading } from '@org/shared-types';

const DEFAULT_DSN = 'postgresql://poke:poke@localhost:5432/poke';

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
@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private pool!: Pool;
  private listenClient!: Client;

  /** Stream neuer Messwerte (gespeist aus pg NOTIFY). */
  readonly readings$ = new Subject<MeterReading>();

  async onModuleInit(): Promise<void> {
    const dsn = process.env.DATABASE_URL || DEFAULT_DSN;
    this.pool = new Pool({ connectionString: dsn });

    this.listenClient = new Client({ connectionString: dsn });
    await this.listenClient.connect();
    this.listenClient.on('notification', (msg) => {
      if (!msg.payload) return;
      try {
        const row = JSON.parse(msg.payload) as Record<string, unknown>;
        this.readings$.next(rowToReading(row));
      } catch (err) {
        this.logger.warn(`Konnte NOTIFY-Payload nicht parsen: ${err}`);
      }
    });
    this.listenClient.on('error', (err) =>
      this.logger.error(`LISTEN-Client-Fehler: ${err}`),
    );
    await this.listenClient.query('LISTEN meter_reading');
    this.logger.log('Verbunden, LISTEN meter_reading aktiv');
  }

  async onModuleDestroy(): Promise<void> {
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
