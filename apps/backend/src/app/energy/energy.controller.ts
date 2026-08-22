import { Controller, Get, Query } from '@nestjs/common';
import type {
  ConsumerDaySummary,
  ConsumerMinuteEnergy,
  EnergyBalance,
  ProductionDaySummary,
  ProductionMinutePower,
} from '@org/shared-types';
import { parseRange, startOfMonth } from '../common/query-params';
import { EnergyService } from './energy.service';

/**
 * Everything the dashboard asks about the household's energy, addressed by the
 * ROLE that answers it rather than by the vendor that happens to serve the
 * role. `/api/sma/energy/daily` used to read `producer_1hour` — a role query
 * wearing a vendor's name, where nothing in the URL told you whether you were
 * getting one device or every device of that role.
 */
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

  @Get('production/daily')
  productionDaily(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<ProductionDaySummary[]> {
    const { from, to } = parseRange(fromStr, toStr);
    return this.energy.productionDaily(from, to);
  }

  @Get('production/minute')
  productionMinute(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<ProductionMinutePower[]> {
    const { from, to } = parseRange(fromStr, toStr);
    return this.energy.productionMinute(from, to);
  }

  @Get('consumers/daily')
  consumersDaily(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<ConsumerDaySummary[]> {
    const { from, to } = parseRange(fromStr, toStr, startOfMonth);
    return this.energy.consumersDaily(from, to);
  }

  @Get('consumers/minute')
  consumersMinute(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
  ): Promise<ConsumerMinuteEnergy[]> {
    const { from, to } = parseRange(fromStr, toStr);
    return this.energy.consumersMinute(from, to);
  }
}
