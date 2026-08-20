import { Controller, Get } from '@nestjs/common';
import type { StatisticsResponse } from '@org/shared-types';
import { StatisticsService } from './statistics.service';

@Controller('statistics')
export class StatisticsController {
  constructor(private readonly statistics: StatisticsService) {}

  /** All-time records, base load and storage sizing. No parameters: the page
   *  is about everything that was ever measured, not about a period. */
  @Get()
  all(): Promise<StatisticsResponse> {
    return this.statistics.statistics();
  }
}
