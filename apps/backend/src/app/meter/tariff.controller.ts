import { BadRequestException, Body, Controller, Get, Put } from '@nestjs/common';
import type { Tariff } from '@org/shared-types';
import { TariffService } from './tariff.service';

@Controller('tariff')
export class TariffController {
  constructor(private readonly tariff: TariffService) {}

  @Get()
  get(): Promise<Tariff> {
    return this.tariff.get();
  }

  @Put()
  save(@Body() body: Partial<Tariff>): Promise<Tariff> {
    const provider =
      body.provider === undefined || body.provider === null ? null : String(body.provider);
    const importCtPerKwh = parsePrice(body.importCtPerKwh, 'importCtPerKwh');
    const exportCtPerKwh = parsePrice(body.exportCtPerKwh, 'exportCtPerKwh');
    return this.tariff.save({ provider, importCtPerKwh, exportCtPerKwh });
  }
}

/** Accept null/empty or a non-negative number. */
function parsePrice(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new BadRequestException(`${field} must be a non-negative number or null`);
  }
  return n;
}
