import { Logger, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import type { Observable } from 'rxjs';
import {
  METER_READING_EVENT,
  SMA_READING_EVENT,
  WALLBOX_READING_EVENT,
} from '@org/shared-types';
import { PgListenService } from '../database/pg-listen.service';
import { rowToReading } from '../meter/meter.mapper';
import { MeterService } from '../meter/meter.service';
import { rowToSmaReading } from '../sma/sma.mapper';
import { SmaService } from '../sma/sma.service';
import { rowToWallboxReading } from '../wallbox/wallbox.mapper';
import { WallboxService } from '../wallbox/wallbox.service';

interface LiveChannel {
  /** socket.io event name pushed to clients */
  event: string;
  /** stream of readings (fed by pg NOTIFY - no polling) */
  stream$: Observable<unknown>;
  /** latest known value, sent to newly connected clients right away */
  latest: () => Promise<unknown | null>;
}

/**
 * Single WebSocket gateway for all live readings. One entry per device in
 * `channels` wires NOTIFY channel -> mapper -> socket.io event; adding a new
 * device is one more entry here.
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
    meter: MeterService,
    wallbox: WallboxService,
    sma: SmaService,
  ) {
    this.channels = [
      {
        event: METER_READING_EVENT,
        stream$: listen.register('meter_reading', rowToReading),
        latest: () => meter.latest(),
      },
      {
        event: WALLBOX_READING_EVENT,
        stream$: listen.register('wallbox_reading', rowToWallboxReading),
        latest: () => wallbox.latest(),
      },
      {
        event: SMA_READING_EVENT,
        stream$: listen.register('sma_reading', rowToSmaReading),
        latest: () => sma.latest(),
      },
    ];
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
