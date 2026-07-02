import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { toLocalDateString } from './date-utils';
import type {
  DataRange,
  EnergyPeriod,
  EnergySummary,
  MeterReading,
  SeriesResolution,
  SeriesResponse,
} from '@org/shared-types';

/** REST access to the smart meter endpoints (/api/meter). */
@Injectable({ providedIn: 'root' })
export class MeterApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/meter';

  latest(): Observable<MeterReading | null> {
    return this.http.get<MeterReading | null>(`${this.base}/latest`);
  }

  range(): Observable<DataRange> {
    return this.http.get<DataRange>(`${this.base}/range`);
  }

  series(
    from: Date,
    to: Date,
    resolution: SeriesResolution,
  ): Observable<SeriesResponse> {
    const params = new HttpParams()
      .set('from', from.toISOString())
      .set('to', to.toISOString())
      .set('resolution', resolution);
    return this.http.get<SeriesResponse>(`${this.base}/series`, { params });
  }

  energy(period: EnergyPeriod, date: Date): Observable<EnergySummary> {
    const params = new HttpParams()
      .set('period', period)
      // YYYY-MM-DD in local time
      .set('date', toLocalDateString(date));
    return this.http.get<EnergySummary>(`${this.base}/energy`, { params });
  }
}
