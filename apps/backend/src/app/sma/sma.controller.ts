import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Query,
} from '@nestjs/common';
import type {
  DataRange,
  SmaConfig,
  SmaDailySummary,
  SmaMinutePower,
  SmaReading,
} from '@org/shared-types';
import { parseConfig, parseRange } from '../common/query-params';
import { SmaService } from './sma.service';

@Controller('sma')
export class SmaController {
  constructor(private readonly sma: SmaService) {}

  @Get('config')
  getConfig(): Promise<SmaConfig> {
    return this.sma.getConfig();
  }

  @Put('config')
  saveConfig(@Body() body: Partial<SmaConfig>): Promise<SmaConfig> {
    const config = parseConfig<SmaConfig>(body, {
      enabled: { kind: 'bool' },
      name: { kind: 'string' },
      host: { kind: 'string' },
      pollIntervalS: { kind: 'int', min: 5, max: 3600, fallback: 60 },
    });
    if (config.enabled && !config.host) {
      throw new BadRequestException('host is required when enabled is true');
    }
    return this.sma.saveConfig(config);
  }

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
