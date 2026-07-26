import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { BillingStatement } from '@org/shared-types';
import { Observable } from 'rxjs';

/** REST access to the billing statement (/api/billing). */
@Injectable({ providedIn: 'root' })
export class BillingApiService {
  private readonly http = inject(HttpClient);

  statement(year: number): Observable<BillingStatement> {
    return this.http.get<BillingStatement>('/api/billing', {
      params: new HttpParams().set('year', year),
    });
  }
}
