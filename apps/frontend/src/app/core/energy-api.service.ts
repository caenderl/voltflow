import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import type { EnergyBalance } from '@org/shared-types';

/**
 * REST access to the household energy figures (/api/energy) — the numbers that
 * describe the house, not a device. Separate from the per-device services
 * because the balance does not change its meaning when the inverter does.
 */
@Injectable({ providedIn: 'root' })
export class EnergyApiService {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/energy';

  /** Energy balance (self-consumption / autarky) over [from, to). */
  balance(from: Date, to: Date): Observable<EnergyBalance> {
    const params = new HttpParams()
      .set('from', from.toISOString())
      .set('to', to.toISOString());
    return this.http.get<EnergyBalance>(`${this.base}/balance`, { params });
  }
}
