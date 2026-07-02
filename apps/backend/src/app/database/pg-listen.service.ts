import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Client } from 'pg';
import { Observable, Subject } from 'rxjs';

const LISTEN_RECONNECT_MS = 5000;

interface ChannelSpec {
  subject: Subject<unknown>;
  map: (row: Record<string, unknown>) => unknown;
}

/**
 * Live push via pg LISTEN/NOTIFY: one dedicated client (auto-reconnect) that
 * fans NOTIFY payloads out to registered channels.
 *
 * Consumers call `register(channel, map)` (in their constructor, i.e. before
 * onModuleInit connects) and get an Observable of mapped readings. Adding a
 * new device is one register() call - no changes here.
 */
@Injectable()
export class PgListenService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PgListenService.name);
  private readonly channels = new Map<string, ChannelSpec>();
  private client: Client | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  /** Subscribe to a NOTIFY channel; payload rows are mapped via `map`. */
  register<T>(
    channel: string,
    map: (row: Record<string, unknown>) => T,
  ): Observable<T> {
    const existing = this.channels.get(channel);
    if (existing) return existing.subject.asObservable() as Observable<T>;

    const subject = new Subject<unknown>();
    this.channels.set(channel, { subject, map });
    // Late registration after connect: LISTEN on the live client right away.
    if (this.client) {
      void this.client
        .query(`LISTEN ${channel}`)
        .catch((err) => this.logger.error(`LISTEN ${channel} failed: ${err}`));
    }
    return subject.asObservable() as Observable<T>;
  }

  onModuleInit(): void {
    void this.connect();
  }

  /** Set up the dedicated LISTEN client; reconnect automatically on failure. */
  private async connect(): Promise<void> {
    if (this.stopped) return;
    const dsn = process.env.DATABASE_URL;
    if (!dsn) {
      // DbService already fails hard on this; just don't spin here.
      this.logger.error('DATABASE_URL not set - live push disabled.');
      return;
    }
    const client = new Client({ connectionString: dsn });
    client.on('notification', (msg) => {
      const spec = this.channels.get(msg.channel);
      if (!spec || !msg.payload) return;
      try {
        const row = JSON.parse(msg.payload) as Record<string, unknown>;
        spec.subject.next(spec.map(row));
      } catch (err) {
        this.logger.warn(`Could not parse NOTIFY payload: ${err}`);
      }
    });
    // error/end -> connection is considered dead, schedule a reconnect
    client.on('error', (err) => {
      this.logger.error(`LISTEN client error: ${err.message}`);
      this.handleFailure(client);
    });
    client.on('end', () => this.handleFailure(client));

    try {
      await client.connect();
      for (const channel of this.channels.keys()) {
        await client.query(`LISTEN ${channel}`);
      }
      this.client = client;
      this.logger.log(`LISTEN active: ${[...this.channels.keys()].join(', ')}`);
    } catch (err) {
      this.logger.warn(
        `LISTEN connection failed, retrying in ${LISTEN_RECONNECT_MS}ms: ${err}`,
      );
      this.handleFailure(client);
    }
  }

  /** Neutralize the dead client and schedule a (single) reconnect. */
  private handleFailure(client: Client): void {
    if (this.stopped) return;
    // Remove the dead client's handlers, but keep a no-op error handler so that
    // late 'error' events do not crash the process as unhandled.
    client.removeAllListeners();
    client.on('error', () => undefined);
    void client.end().catch(() => undefined);
    if (this.client === client) this.client = null;

    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, LISTEN_RECONNECT_MS);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.client?.end().catch(() => undefined);
  }
}
