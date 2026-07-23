import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  AppSettings,
  MeterCheckpoint,
  MeterCheckpointInput,
  MeterReconciliation,
  Tariff,
} from '@org/shared-types';

/** REST access to user settings: tariff and manual meter checkpoints. */
@Injectable({ providedIn: 'root' })
export class SettingsApiService {
  private readonly http = inject(HttpClient);

  tariff(): Observable<Tariff> {
    return this.http.get<Tariff>('/api/tariff');
  }

  saveTariff(t: Tariff): Observable<Tariff> {
    return this.http.put<Tariff>('/api/tariff', t);
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
