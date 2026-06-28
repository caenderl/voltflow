import { Logger, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { SMA_READING_EVENT } from '@org/shared-types';
import { DbService } from '../database/db.service';
import { SmaService } from './sma.service';

/**
 * Pushes live SMA readings to connected clients. Source is
 * DbService.smaReadings$ (fed by pg NOTIFY) - no polling.
 */
@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200' },
})
export class SmaGateway implements OnModuleInit, OnGatewayConnection {
  private readonly logger = new Logger(SmaGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly db: DbService,
    private readonly sma: SmaService,
  ) {}

  onModuleInit(): void {
    this.db.smaReadings$.subscribe((reading) => {
      this.server.emit(SMA_READING_EVENT, reading);
    });
  }

  /** Send the latest known SMA value to newly connected clients. */
  async handleConnection(client: Socket): Promise<void> {
    const latest = await this.sma.latest();
    if (latest) client.emit(SMA_READING_EVENT, latest);
  }
}
