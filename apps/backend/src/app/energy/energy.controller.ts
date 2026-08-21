import { Controller, Get, Query } from '@nestjs/common';
import type { EnergyBalance } from '@org/shared-types';
import { parseRange } from '../common/query-params';
import { EnergyService } from './energy.service';

@Controller('energy')
export class EnergyController {
  constructor(private readonly energy: EnergyService) {}

  /** Self-consumption and autarky over [from, to). */
  @Get('balance')
  balance(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<EnergyBalance> {
    const { from, to } = parseRange(fromStr, toStr);
    return this.energy.balance(from, to);
  }
}
