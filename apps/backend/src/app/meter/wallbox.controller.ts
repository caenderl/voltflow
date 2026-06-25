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
  WallboxReading,
} from '@org/shared-types';
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
    const host =
      body.host === undefined || body.host === null || body.host === ''
        ? null
        : String(body.host).trim();
    const config: WallboxConfig = {
      enabled: Boolean(body.enabled),
      host,
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

  @Get('history')
  history(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<WallboxReading[]> {
    const to = toStr ? new Date(toStr) : new Date();
    const from = fromStr
      ? new Date(fromStr)
      : new Date(to.getTime() - 60 * 60 * 1000); // default: last hour
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new BadRequestException('Invalid from/to timestamp.');
    }
    return this.wallbox.history(from, to);
  }
}

/** Parse an integer within [min, max]; empty/undefined -> fallback. */
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
