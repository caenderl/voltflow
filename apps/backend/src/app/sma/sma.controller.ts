import { Controller, Get, Query } from '@nestjs/common';
import type { SmaDailySummary, SmaMinutePower } from '@org/shared-types';
import { parseRange } from '../common/query-params';
import { SmaService } from './sma.service';

/**
 * Aggregate PV figures. The inverter's *live* values do not go through REST at
 * all — they arrive over the WebSocket, which is also what carries the initial
 * state, so there is no `latest` endpoint here for anything to fall out of sync
 * with.
 */
@Controller('sma')
export class SmaController {
  constructor(private readonly sma: SmaService) {}

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
