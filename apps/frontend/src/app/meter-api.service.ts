import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  EnergyPeriod,
  EnergySummary,
  MeterReading,
  SeriesResolution,
  SeriesResponse,
} from '@org/shared-types';

@Injectable({ providedIn: 'root' })
export class MeterApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/meter';

  latest(): Observable<MeterReading | null> {
    return this.http.get<MeterReading | null>(`${this.base}/latest`);
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
      // YYYY-MM-DD in lokaler Zeit
      .set('date', toLocalDateString(date));
    return this.http.get<EnergySummary>(`${this.base}/energy`, { params });
  }
}

function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
