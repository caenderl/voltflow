import { Logger, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { METER_READING_EVENT } from '@org/shared-types';
import { DbService } from './db.service';
import { MeterService } from './meter.service';

/**
 * Pusht Live-Messwerte an verbundene Clients. Quelle ist DbService.readings$
 * (gespeist aus pg NOTIFY) - kein Polling.
 */
@WebSocketGateway({ cors: { origin: '*' } })
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

  /** Neuen Clients direkt den letzten bekannten Wert schicken. */
  async handleConnection(client: Socket): Promise<void> {
    this.logger.log(`Client verbunden: ${client.id}`);
    const latest = await this.meter.latest();
    if (latest) client.emit(METER_READING_EVENT, latest);
  }
}
