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
  WallboxConfig,
  WallboxDailySummary,
  WallboxHourlySummary,
  WallboxReading,
} from '@org/shared-types';
import {
  emptyToNull,
  parseIntInRange,
  parseRange,
  startOfMonth,
} from '../common/query-params';
import { WallboxService } from './wallbox.service';

@Controller('wallbox')
export class WallboxController {
  constructor(private readonly wallbox: WallboxService) {}

  @Get('config')
  getConfig(): Promise<WallboxConfig> {
    return this.wallbox.getConfig();
  }

  @Put('config')
  saveConfig(@Body() body: Partial<WallboxConfig>): Promise<WallboxConfig> {
    const config: WallboxConfig = {
      enabled: Boolean(body.enabled),
      name: emptyToNull(body.name),
      host: emptyToNull(body.host),
      port: parseIntInRange(body.port, 'port', 1, 65535, 502),
      unitId: parseIntInRange(body.unitId, 'unitId', 0, 255, 1),
      pollIntervalS: parseIntInRange(body.pollIntervalS, 'pollIntervalS', 5, 3600, 30),
    };
    // Enabling without a host makes no sense -> reject early.
    if (config.enabled && !config.host) {
      throw new BadRequestException('host is required when enabled is true');
    }
    return this.wallbox.saveConfig(config);
  }

  @Get('latest')
  latest(): Promise<WallboxReading | null> {
    return this.wallbox.latest();
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
