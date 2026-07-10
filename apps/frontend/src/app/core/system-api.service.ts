import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type { SystemHealth } from '@org/shared-types';

/** REST access to host health for the admin "System" tab (polled, not stored). */
@Injectable({ providedIn: 'root' })
export class SystemApiService {
  private readonly http = inject(HttpClient);

  health(): Observable<SystemHealth> {
    return this.http.get<SystemHealth>('/api/system/health');
  }
}
