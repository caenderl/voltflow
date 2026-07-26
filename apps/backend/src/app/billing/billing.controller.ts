import { Controller, Get, Query } from '@nestjs/common';
import type { BillingStatement } from '@org/shared-types';
import { parseIntInRange } from '../common/query-params';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Statement for one calendar year; defaults to the current one. */
  @Get()
  statement(@Query('year') year?: string): Promise<BillingStatement> {
    return this.billing.statement(
      parseIntInRange(year, 'year', 2000, 2100, new Date().getFullYear()),
    );
  }
}
