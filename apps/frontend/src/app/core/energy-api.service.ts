import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  ConsumerDaySummary,
  ConsumerMinuteEnergy,
  EnergyBalance,
  ProductionDaySummary,
  ProductionMinutePower,
} from '@org/shared-types';

/**
 * REST access to the household energy figures (/api/energy) — every number that
 * describes the house rather than a device, addressed by the role that answers
 * it. There is no per-device REST service left beside it: live readings arrive
 * over the WebSocket, and nothing else the dashboard shows is about one box.
 */
@Injectable({ providedIn: 'root' })
export class EnergyApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/energy';

  /** Energy balance (self-consumption / autarky) over [from, to). */
  balance(from: Date, to: Date): Observable<EnergyBalance> {
    return this.http.get<EnergyBalance>(`${this.base}/balance`, {
      params: range(from, to),
    });
  }

  /** PV yield per local day over [from, to), over all producers. */
  productionDaily(from: Date, to: Date): Observable<ProductionDaySummary[]> {
    return this.http.get<ProductionDaySummary[]>(`${this.base}/production/daily`, {
      params: range(from, to),
    });
  }

  /** Average PV power per minute over [from, to). */
  productionMinute(from: Date, to: Date): Observable<ProductionMinutePower[]> {
    return this.http.get<ProductionMinutePower[]>(`${this.base}/production/minute`, {
      params: range(from, to),
    });
  }

  /** Energy drawn by the metered consumers per local day over [from, to). */
  consumersDaily(from: Date, to: Date): Observable<ConsumerDaySummary[]> {
    return this.http.get<ConsumerDaySummary[]>(`${this.base}/consumers/daily`, {
      params: range(from, to),
    });
  }

  /** The same per minute, for the day view. */
  consumersMinute(from: Date, to: Date): Observable<ConsumerMinuteEnergy[]> {
    return this.http.get<ConsumerMinuteEnergy[]>(`${this.base}/consumers/minute`, {
      params: range(from, to),
    });
  }
}

const range = (from: Date, to: Date): HttpParams =>
  new HttpParams().set('from', from.toISOString()).set('to', to.toISOString());
