import { Controller, Get, Query } from '@nestjs/common';
import type { DataRange, SmaDailySummary, SmaMinutePower, SmaReading } from '@org/shared-types';
import { parseRange } from '../common/query-params';
import { SmaService } from './sma.service';

@Controller('sma')
export class SmaController {
  constructor(private readonly sma: SmaService) {}

  /**
   * Latest reading. `deviceSn` picks one device; without it the newest reading
   * across all devices of this kind is returned (unambiguous while there is
   * exactly one).
   */
  @Get('latest')
  latest(@Query('deviceSn') deviceSn?: string): Promise<SmaReading | null> {
    return this.sma.latest(deviceSn);
  }

  @Get('range')
  range(): Promise<DataRange> {
    return this.sma.range();
  }

  @Get('history')
  history(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<SmaReading[]> {
    const { from, to } = parseRange(fromStr, toStr);
    return this.sma.history(from, to);
  }

  @Get('energy/daily')
  dailyEnergy(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<SmaDailySummary[]> {
    const { from, to } = parseRange(fromStr, toStr);
    return this.sma.dailyEnergy(from, to);
  }

  @Get('power/minute')
  minutePower(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<SmaMinutePower[]> {
    const { from, to } = parseRange(fromStr, toStr);
    return this.sma.minutePower(from, to);
  }
}
