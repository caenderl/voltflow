import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  EnergyBalance,
  SmaConfig,
  SmaDailySummary,
  SmaMinutePower,
  SmaReading,
} from '@org/shared-types';

/** REST access to the SMA inverter endpoints (/api/sma). */
@Injectable({ providedIn: 'root' })
export class SmaApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/sma';

  config(): Observable<SmaConfig> {
    return this.http.get<SmaConfig>(`${this.base}/config`);
  }

  saveConfig(c: SmaConfig): Observable<SmaConfig> {
    return this.http.put<SmaConfig>(`${this.base}/config`, c);
  }

  latest(): Observable<SmaReading | null> {
    return this.http.get<SmaReading | null>(`${this.base}/latest`);
  }

  /** Energy balance (self-consumption / autarky) over [from, to). */
  balance(from: Date, to: Date): Observable<EnergyBalance> {
    const params = new HttpParams()
      .set('from', from.toISOString())
      .set('to', to.toISOString());
    return this.http.get<EnergyBalance>(`${this.base}/balance`, { params });
  }

  /** Daily PV yield over [from, to). */
  dailyEnergy(from: Date, to: Date): Observable<SmaDailySummary[]> {
    const params = new HttpParams()
      .set('from', from.toISOString())
      .set('to', to.toISOString());
    return this.http.get<SmaDailySummary[]>(`${this.base}/energy/daily`, { params });
  }

  /** Per-minute average PV power over [from, to). */
  minutePower(from: Date, to: Date): Observable<SmaMinutePower[]> {
    const params = new HttpParams()
      .set('from', from.toISOString())
      .set('to', to.toISOString());
    return this.http.get<SmaMinutePower[]>(`${this.base}/power/minute`, { params });
  }
}
