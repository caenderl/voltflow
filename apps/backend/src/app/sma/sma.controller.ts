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
  EnergyBalance,
  HouseLoadPoint,
  SmaConfig,
  SmaDailySummary,
  SmaReading,
} from '@org/shared-types';
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
    const name = emptyToNull(body.name);
    const host = emptyToNull(body.host);
    const config: SmaConfig = {
      enabled: Boolean(body.enabled),
      name,
      host,
      pollIntervalS: parseIntInRange(body.pollIntervalS, 'pollIntervalS', 5, 3600, 60),
    };
    if (config.enabled && !config.host) {
      throw new BadRequestException('host is required when enabled is true');
    }
    return this.sma.saveConfig(config);
  }

  @Get('latest')
  latest(): Promise<SmaReading | null> {
    return this.sma.latest();
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

  @Get('house-load')
  houseLoad(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<HouseLoadPoint[]> {
    const { from, to } = parseRange(fromStr, toStr);
    return this.sma.houseLoad(from, to);
  }

  @Get('balance')
  balance(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<EnergyBalance> {
    const { from, to } = parseRange(fromStr, toStr);
    return this.sma.balance(from, to);
  }
}

function emptyToNull(value: unknown): string | null {
  return value === undefined || value === null || value === ''
    ? null
    : String(value).trim();
}

function parseRange(fromStr?: string, toStr?: string): { from: Date; to: Date } {
  const to = toStr ? new Date(toStr) : new Date();
  const from = fromStr ? new Date(fromStr) : new Date(to.getTime() - 60 * 60 * 1000);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    throw new BadRequestException('Invalid from/to timestamp.');
  }
  return { from, to };
}

function parseIntInRange(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new BadRequestException(`${field} must be an integer in [${min}, ${max}]`);
  }
  return n;
}
