import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type {
  DataRange,
  EnergyPeriod,
  EnergySummary,
  SeriesResolution,
  SeriesResponse,
} from '@org/shared-types';
import { parseRange } from '../common/query-params';
import { MeterService } from './meter.service';

const RESOLUTIONS: SeriesResolution[] = ['raw', '1min', '1hour', '1day'];
const PERIODS: EnergyPeriod[] = ['day', 'week', 'month'];

/**
 * Stays under `meter` rather than moving to `/api/energy` with the production
 * and consumer figures, even though `series`/`energy` read the `grid_meter_*`
 * role views like those do. "Meter" here already names the role — there is one
 * grid meter, it is the house connection point, and `/api/meter/energy` says
 * exactly what it returns. `/api/sma/energy/daily` did not: nothing in it said
 * whether you were getting one inverter or every producer.
 */
@Controller('meter')
export class MeterController {
  constructor(private readonly meter: MeterService) {}

  @Get('range')
  range(): Promise<DataRange> {
    return this.meter.range();
  }

  @Get('series')
  series(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
    @Query('resolution') resolution?: string,
  ): Promise<SeriesResponse> {
    const { from, to } = parseRange(fromStr, toStr);
    const res = (resolution ?? '1min') as SeriesResolution;
    if (!RESOLUTIONS.includes(res)) {
      throw new BadRequestException(`resolution must be one of ${RESOLUTIONS}`);
    }
    return this.meter.series(from, to, res);
  }

  @Get('energy')
  async energy(
    @Query('period') periodStr?: string,
    @Query('date') dateStr?: string,
  ): Promise<EnergySummary> {
    const period = (periodStr ?? 'day') as EnergyPeriod;
    if (!PERIODS.includes(period)) {
      throw new BadRequestException(`period must be one of ${PERIODS}`);
    }
    const ref = dateStr ? new Date(dateStr) : new Date();
    if (isNaN(ref.getTime())) {
      throw new BadRequestException('Invalid date.');
    }
    const { from, to } = await this.meter.computeRange(period, ref);
    return this.meter.energy(period, from, to);
  }
}
