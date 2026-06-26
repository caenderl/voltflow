import { Logger, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { WALLBOX_READING_EVENT } from '@org/shared-types';
import { DbService } from '../database/db.service';
import { WallboxService } from './wallbox.service';

/**
 * Pushes live wallbox readings to connected clients. Source is
 * DbService.wallboxReadings$ (fed by pg NOTIFY) - no polling.
 */
@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200' },
})
export class WallboxGateway implements OnModuleInit, OnGatewayConnection {
  private readonly logger = new Logger(WallboxGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly db: DbService,
    private readonly wallbox: WallboxService,
  ) {}

  onModuleInit(): void {
    this.db.wallboxReadings$.subscribe((reading) => {
      this.server.emit(WALLBOX_READING_EVENT, reading);
    });
  }

  /** Send the latest known wallbox value to newly connected clients. */
  async handleConnection(client: Socket): Promise<void> {
    const latest = await this.wallbox.latest();
    if (latest) client.emit(WALLBOX_READING_EVENT, latest);
  }
}
