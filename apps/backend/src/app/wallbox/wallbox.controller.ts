import { Controller, Get, Query } from '@nestjs/common';
import type { WallboxDailySummary, WallboxReading } from '@org/shared-types';
import { parseRange, startOfMonth } from '../common/query-params';
import { WallboxService } from './wallbox.service';

/**
 * Aggregate and raw charging figures. Live values arrive over the WebSocket
 * (which also carries the initial state), so there is no `latest` endpoint.
 */
@Controller('wallbox')
export class WallboxController {
  constructor(private readonly wallbox: WallboxService) {}

  @Get('energy/daily')
  dailyEnergy(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<WallboxDailySummary[]> {
    const { from, to } = parseRange(fromStr, toStr, startOfMonth);
    return this.wallbox.dailyEnergy(from, to);
  }

  @Get('history')
  history(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<WallboxReading[]> {
    const { from, to } = parseRange(fromStr, toStr);
    return this.wallbox.history(from, to);
  }
}
