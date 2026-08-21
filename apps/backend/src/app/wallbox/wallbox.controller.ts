import { Controller, Get, Query } from '@nestjs/common';
import type {
  DataRange,
  WallboxDailySummary,
  WallboxHourlySummary,
  WallboxReading,
} from '@org/shared-types';
import { parseRange, startOfMonth } from '../common/query-params';
import { WallboxService } from './wallbox.service';

@Controller('wallbox')
export class WallboxController {
  constructor(private readonly wallbox: WallboxService) {}

  /**
   * Latest reading. `deviceSn` picks one device; without it the newest reading
   * across all devices of this kind is returned (unambiguous while there is
   * exactly one).
   */
  @Get('latest')
  latest(@Query('deviceSn') deviceSn?: string): Promise<WallboxReading | null> {
    return this.wallbox.latest(deviceSn);
  }

  @Get('range')
  range(): Promise<DataRange> {
    return this.wallbox.range();
  }

  @Get('energy/daily')
  dailyEnergy(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<WallboxDailySummary[]> {
    const { from, to } = parseRange(fromStr, toStr, startOfMonth);
    return this.wallbox.dailyEnergy(from, to);
  }

  @Get('energy/hourly')
  hourlyEnergy(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<WallboxHourlySummary[]> {
    const { from, to } = parseRange(fromStr, toStr);
    return this.wallbox.hourlyEnergy(from, to);
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
