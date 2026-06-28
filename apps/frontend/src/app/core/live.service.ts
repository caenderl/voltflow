import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { io, Socket } from 'socket.io-client';
import {
  METER_READING_EVENT,
  SMA_READING_EVENT,
  WALLBOX_READING_EVENT,
  type MeterReading,
  type SmaReading,
  type WallboxReading,
} from '@org/shared-types';

/**
 * Provides live readings over the WebSocket connection to the backend.
 * In dev the connection runs through the NX proxy (/socket.io -> :3000).
 */
@Injectable({ providedIn: 'root' })
export class LiveService {
  private socket: Socket | null = null;

  private get conn(): Socket {
    return (this.socket ??= io());
  }

  readings$(): Observable<MeterReading> {
    return this.on<MeterReading>(METER_READING_EVENT);
  }

  wallboxReadings$(): Observable<WallboxReading> {
    return this.on<WallboxReading>(WALLBOX_READING_EVENT);
  }

  smaReadings$(): Observable<SmaReading> {
    return this.on<SmaReading>(SMA_READING_EVENT);
  }

  private on<T>(event: string): Observable<T> {
    return new Observable<T>((subscriber) => {
      const socket = this.conn;
      const handler = (payload: T) => subscriber.next(payload);
      socket.on(event, handler);
      return () => socket.off(event, handler);
    });
  }
}
