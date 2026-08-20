import { Controller, Get, Query } from '@nestjs/common';
import type { BillingStatement } from '@org/shared-types';
import { parseIntInRange } from '../common/query-params';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /**
   * Statement for one calendar year; defaults to the current one.
   *
   * The default is resolved in the DB rather than from `new Date()`, so it is
   * the year it is in {@link TIMEZONE} and not in the Node process's own zone
   * (UTC in prod) — the two disagree for the ~1-2 h around New Year's Eve.
   * Only fetched when no year was given, so an explicit `?year=` costs no
   * extra round-trip.
   */
  @Get()
  async statement(@Query('year') year?: string): Promise<BillingStatement> {
    const requested =
      year === undefined || year === ''
        ? await this.billing.currentYear()
        : parseIntInRange(year, 'year', 2000, 2100);
    return this.billing.statement(requested);
  }
}
