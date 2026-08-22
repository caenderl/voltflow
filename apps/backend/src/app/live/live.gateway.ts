import { Inject, Logger, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type { Observable } from 'rxjs';
import { PgListenService } from '../database/pg-listen.service';
import { LIVE_DEVICES, type LiveDeviceDescriptor } from './live-device';

/** A device descriptor with its NOTIFY stream wired up. */
interface LiveChannel {
  event: string;
  stream$: Observable<unknown>;
  latestPerDevice: () => Promise<unknown[]>;
}

/**
 * Single WebSocket gateway for all live readings. It knows nothing about the
 * individual devices — it iterates the injected LIVE_DEVICES registry, wiring
 * each descriptor's NOTIFY channel -> mapper -> socket.io event. Adding a device
 * is a new descriptor in the registry, not a change here.
 */
@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200' },
})
export class LiveGateway implements OnModuleInit, OnGatewayConnection {
  private readonly logger = new Logger(LiveGateway.name);
  private readonly channels: LiveChannel[];

  @WebSocketServer()
  server!: Server;

  constructor(
    listen: PgListenService,
    @Inject(LIVE_DEVICES) devices: LiveDeviceDescriptor[],
  ) {
    this.channels = devices.map((d) => ({
      event: d.event,
      stream$: listen.register(d.notifyChannel, d.map),
      latestPerDevice: d.latestPerDevice,
    }));
  }

  onModuleInit(): void {
    for (const { event, stream$ } of this.channels) {
      stream$.subscribe((reading) => this.server.emit(event, reading));
    }
  }

  /**
   * Send every device's last known reading to a new client — one emit per
   * device, on the same event the live stream uses, so a client that keys its
   * state by `deviceSn` needs no separate "initial state" message shape.
   *
   * Channels are fetched concurrently and independently: one channel's DB error
   * must not block the others, and — since NestJS's socket.io adapter awaits
   * this with no .catch() of its own — must never reject out of this method, or
   * it becomes an unhandled rejection that crashes the process.
   */
  async handleConnection(client: Socket): Promise<void> {
    this.logger.log(`Client connected: ${client.id}`);
    await Promise.allSettled(
      this.channels.map(async ({ event, latestPerDevice }) => {
        try {
          for (const reading of await latestPerDevice()) client.emit(event, reading);
        } catch (err) {
          this.logger.error(
            `Failed to fetch latest "${event}" for ${client.id}`,
            err instanceof Error ? err.stack : String(err),
          );
        }
      }),
    );
  }
}
