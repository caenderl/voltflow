import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type { DeviceInfo } from '@org/shared-types';

/**
 * REST access to the device registry (/api/devices) — every device a collector
 * has ever registered, with the roles the domain reads it through. Distinct
 * from {@link DeviceConfigApiService}, which is what the *user* configured: a
 * device appears here once it has been seen, whether or not a config row points
 * at it (the smart meter never has one).
 */
@Injectable({ providedIn: 'root' })
export class DevicesApiService {
  private readonly http = inject(HttpClient);

  list(): Observable<DeviceInfo[]> {
    return this.http.get<DeviceInfo[]>('/api/devices');
  }
}
