import { Logger, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { METER_READING_EVENT } from '@org/shared-types';
import { DbService } from '../database/db.service';
import { MeterService } from './meter.service';

/**
 * Pushes live readings to connected clients. Source is DbService.readings$
 * (fed by pg NOTIFY) - no polling.
 */
@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200' },
})
export class MeterGateway implements OnModuleInit, OnGatewayConnection {
  private readonly logger = new Logger(MeterGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly db: DbService,
    private readonly meter: MeterService,
  ) {}

  onModuleInit(): void {
    this.db.readings$.subscribe((reading) => {
      this.server.emit(METER_READING_EVENT, reading);
    });
  }

  /** Send the latest known value to newly connected clients right away. */
  async handleConnection(client: Socket): Promise<void> {
    this.logger.log(`Client connected: ${client.id}`);
    const latest = await this.meter.latest();
    if (latest) client.emit(METER_READING_EVENT, latest);
  }
}
