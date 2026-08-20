import { Controller, Get, Query } from '@nestjs/common';
import type { BillingStatement } from '@org/shared-types';
import { parseIntInRange } from '../common/query-params';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Statement for one calendar year; defaults to the current one. */
  @Get()
  async statement(@Query('year') year?: string): Promise<BillingStatement> {
    const fallback = year ? 0 : await this.billing.currentYear();
    return this.billing.statement(
      parseIntInRange(year, 'year', 2000, 2100, fallback),
    );
  }
}
