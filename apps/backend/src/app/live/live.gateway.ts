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
  latest: () => Promise<unknown | null>;
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
      latest: d.latest,
    }));
  }

  onModuleInit(): void {
    for (const { event, stream$ } of this.channels) {
      stream$.subscribe((reading) => this.server.emit(event, reading));
    }
  }

  /** Send the latest known value of every channel to a new client. */
  async handleConnection(client: Socket): Promise<void> {
    this.logger.log(`Client connected: ${client.id}`);
    for (const { event, latest } of this.channels) {
      const reading = await latest();
      if (reading) client.emit(event, reading);
    }
  }
}
