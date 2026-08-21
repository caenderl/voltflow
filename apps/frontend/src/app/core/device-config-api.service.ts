import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type { DeviceConfig, DeviceConfigCreateInput, DeviceConfigInput } from '@org/shared-types';

/** REST access to configured device instances (/api/device-configs). */
@Injectable({ providedIn: 'root' })
export class DeviceConfigApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/device-configs';

  list(): Observable<DeviceConfig[]> {
    return this.http.get<DeviceConfig[]>(this.base);
  }

  create(input: DeviceConfigCreateInput): Observable<DeviceConfig> {
    return this.http.post<DeviceConfig>(this.base, input);
  }

  update(id: number, input: DeviceConfigInput): Observable<DeviceConfig> {
    return this.http.put<DeviceConfig>(`${this.base}/${id}`, input);
  }

  delete(id: number): Observable<void> {
    return this.http.delete<void>(`${this.base}/${id}`);
  }
}
