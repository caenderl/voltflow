import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import { METER_READING_EVENT, type MeterReading } from '@org/shared-types';

/**
 * Provides live readings over the WebSocket connection to the backend.
 * In dev the connection runs through the NX proxy (/socket.io -> :3000).
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private socket: Socket | null = null;

  readings$(): Observable<MeterReading> {
    return new Observable<MeterReading>((subscriber) => {
      this.socket ??= io();
      const handler = (reading: MeterReading) => subscriber.next(reading);
      this.socket.on(METER_READING_EVENT, handler);
      return () => this.socket?.off(METER_READING_EVENT, handler);
    });
  }
}
