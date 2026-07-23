import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AppSettings,
  MeterCheckpoint,
  MeterCheckpointInput,
  MeterReconciliation,
  TariffPeriod,
  TariffPeriodInput,
} from '@org/shared-types';

/** REST access to user settings: tariff periods and manual meter checkpoints. */
@Injectable({ providedIn: 'root' })
export class SettingsApiService {
  private readonly http = inject(HttpClient);

  tariffPeriods(): Observable<TariffPeriod[]> {
    return this.http.get<TariffPeriod[]>('/api/tariff-periods');
  }

  createTariffPeriod(input: TariffPeriodInput): Observable<TariffPeriod> {
    return this.http.post<TariffPeriod>('/api/tariff-periods', input);
  }

  updateTariffPeriod(id: number, input: TariffPeriodInput): Observable<TariffPeriod> {
    return this.http.put<TariffPeriod>(`/api/tariff-periods/${id}`, input);
  }

  deleteTariffPeriod(id: number): Observable<void> {
    return this.http.delete<void>(`/api/tariff-periods/${id}`);
  }

  appSettings(): Observable<AppSettings> {
    return this.http.get<AppSettings>('/api/app-settings');
  }

  saveAppSettings(s: AppSettings): Observable<AppSettings> {
    return this.http.put<AppSettings>('/api/app-settings', s);
  }

  meterCheckpoints(): Observable<MeterCheckpoint[]> {
    return this.http.get<MeterCheckpoint[]>('/api/meter-checkpoints');
  }

  meterReconciliation(): Observable<MeterReconciliation> {
    return this.http.get<MeterReconciliation>('/api/meter-checkpoints/reconciliation');
  }

  createMeterCheckpoint(input: MeterCheckpointInput): Observable<MeterCheckpoint> {
    return this.http.post<MeterCheckpoint>('/api/meter-checkpoints', input);
  }

  updateMeterCheckpoint(id: number, input: MeterCheckpointInput): Observable<MeterCheckpoint> {
    return this.http.put<MeterCheckpoint>(`/api/meter-checkpoints/${id}`, input);
  }

  deleteMeterCheckpoint(id: number): Observable<void> {
    return this.http.delete<void>(`/api/meter-checkpoints/${id}`);
  }
}
