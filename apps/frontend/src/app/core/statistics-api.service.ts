import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { StatisticsResponse } from '@org/shared-types';
import { Observable } from 'rxjs';

/** REST access to the all-time statistics (/api/statistics). */
@Injectable({ providedIn: 'root' })
export class StatisticsApiService {
  private readonly http = inject(HttpClient);

  statistics(): Observable<StatisticsResponse> {
    return this.http.get<StatisticsResponse>('/api/statistics');
  }
}
