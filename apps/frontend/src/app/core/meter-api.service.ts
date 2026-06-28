import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  DataRange,
  EnergyBalance,
  EnergyPeriod,
  EnergySummary,
  MeterReading,
  SeriesResolution,
  SeriesResponse,
  SmaConfig,
  SmaReading,
  Tariff,
  WallboxConfig,
  WallboxDailySummary,
  WallboxReading,
} from '@org/shared-types';

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

  tariff(): Observable<Tariff> {
    return this.http.get<Tariff>('/api/tariff');
  }

  saveTariff(t: Tariff): Observable<Tariff> {
    return this.http.put<Tariff>('/api/tariff', t);
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

  // --- Wallbox ---

  wallboxConfig(): Observable<WallboxConfig> {
    return this.http.get<WallboxConfig>('/api/wallbox/config');
  }

  saveWallboxConfig(c: WallboxConfig): Observable<WallboxConfig> {
    return this.http.put<WallboxConfig>('/api/wallbox/config', c);
  }

  wallboxLatest(): Observable<WallboxReading | null> {
    return this.http.get<WallboxReading | null>('/api/wallbox/latest');
  }

  wallboxDailyEnergy(from: Date, to: Date): Observable<WallboxDailySummary[]> {
    const params = new HttpParams()
      .set('from', from.toISOString())
      .set('to', to.toISOString());
    return this.http.get<WallboxDailySummary[]>('/api/wallbox/energy/daily', { params });
  }

  // --- SMA inverter ---

  smaConfig(): Observable<SmaConfig> {
    return this.http.get<SmaConfig>('/api/sma/config');
  }

  saveSmaConfig(c: SmaConfig): Observable<SmaConfig> {
    return this.http.put<SmaConfig>('/api/sma/config', c);
  }

  smaLatest(): Observable<SmaReading | null> {
    return this.http.get<SmaReading | null>('/api/sma/latest');
  }

  /** Energy balance (self-consumption / autarky) over [from, to). */
  energyBalance(from: Date, to: Date): Observable<EnergyBalance> {
    const params = new HttpParams()
      .set('from', from.toISOString())
      .set('to', to.toISOString());
    return this.http.get<EnergyBalance>('/api/sma/balance', { params });
  }
}

function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
