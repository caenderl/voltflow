import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  WallboxConfig,
  WallboxDailySummary,
  WallboxReading,
} from '@org/shared-types';

/** REST access to the wallbox endpoints (/api/wallbox). */
@Injectable({ providedIn: 'root' })
export class WallboxApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/wallbox';

  config(): Observable<WallboxConfig> {
    return this.http.get<WallboxConfig>(`${this.base}/config`);
  }

  saveConfig(c: WallboxConfig): Observable<WallboxConfig> {
    return this.http.put<WallboxConfig>(`${this.base}/config`, c);
  }

  latest(): Observable<WallboxReading | null> {
    return this.http.get<WallboxReading | null>(`${this.base}/latest`);
  }

  dailyEnergy(from: Date, to: Date): Observable<WallboxDailySummary[]> {
    const params = new HttpParams()
      .set('from', from.toISOString())
      .set('to', to.toISOString());
    return this.http.get<WallboxDailySummary[]>(`${this.base}/energy/daily`, { params });
  }

  /** Raw wallbox readings in [from, to) (day view buckets these into 5-min). */
  history(from: Date, to: Date): Observable<WallboxReading[]> {
    const params = new HttpParams()
      .set('from', from.toISOString())
      .set('to', to.toISOString());
    return this.http.get<WallboxReading[]>(`${this.base}/history`, { params });
  }
}
