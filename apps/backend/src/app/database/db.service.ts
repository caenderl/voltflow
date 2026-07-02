import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Pool } from 'pg';
import { applyMigrations } from './schema';

/**
 * Postgres access for regular queries: a lazily connecting pool plus the
 * idempotent schema migrations on startup. Live push (LISTEN/NOTIFY) lives
 * in PgListenService.
 */
@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private pool!: Pool;

  onModuleInit(): void {
    const dsn = process.env.DATABASE_URL;
    if (!dsn) {
      // Configuration error -> fail hard (no meaningful operation possible)
      throw new Error('DATABASE_URL not set (env or .env).');
    }
    // Pool for REST queries: connects lazily and reconnects per query itself.
    this.pool = new Pool({ connectionString: dsn });
    this.pool.on('error', (err) =>
      this.logger.error(`DB pool error: ${err.message}`),
    );
    // Apply idempotent schema migrations (also catches up pre-existing DBs)
    void applyMigrations(this.pool, this.logger);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end().catch(() => undefined);
  }

  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }> {
    return this.pool.query(text, params) as Promise<{ rows: T[] }>;
  }
}
