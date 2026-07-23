import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import type { TariffPeriod, TariffPeriodInput } from '@org/shared-types';
import { TariffPeriodService } from './tariff-period.service';

@Controller('tariff-periods')
export class TariffPeriodController {
  constructor(private readonly tariffs: TariffPeriodService) {}

  @Get()
  list(): Promise<TariffPeriod[]> {
    return this.tariffs.list();
  }

  @Post()
  create(@Body() body: Partial<TariffPeriodInput>): Promise<TariffPeriod> {
    return this.tariffs.create(parseInput(body));
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Partial<TariffPeriodInput>,
  ): Promise<TariffPeriod> {
    return this.tariffs.update(id, parseInput(body));
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.tariffs.remove(id);
  }
}

function parseInput(body: Partial<TariffPeriodInput>): TariffPeriodInput {
  const validFrom = body.validFrom ? String(body.validFrom).slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) {
    throw new BadRequestException('validFrom must be a YYYY-MM-DD string');
  }
  return {
    validFrom,
    provider:
      body.provider === undefined || body.provider === null || String(body.provider).trim() === ''
        ? null
        : String(body.provider),
    importCtPerKwh: parsePrice(body.importCtPerKwh, 'importCtPerKwh'),
    exportCtPerKwh: parsePrice(body.exportCtPerKwh, 'exportCtPerKwh'),
  };
}

/** Accept null/empty or a non-negative number. */
export function parsePrice(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new BadRequestException(`${field} must be a non-negative number or null`);
  }
  return n;
}
