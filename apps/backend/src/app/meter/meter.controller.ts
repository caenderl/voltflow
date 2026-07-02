import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type {
  DataRange,
  EnergyPeriod,
  EnergySummary,
  MeterReading,
  SeriesResolution,
  SeriesResponse,
} from '@org/shared-types';
import { parseRange } from '../common/query-params';
import { MeterService } from './meter.service';

const RESOLUTIONS: SeriesResolution[] = ['raw', '1min', '1hour', '1day'];
const PERIODS: EnergyPeriod[] = ['day', 'week', 'month'];

@Controller('meter')
export class MeterController {
  constructor(private readonly meter: MeterService) {}

  @Get('latest')
  latest(): Promise<MeterReading | null> {
    return this.meter.latest();
  }

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
  energy(
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
    const { from, to } = computeRange(period, ref);
    return this.meter.energy(period, from, to);
  }
}

/** Returns [from, to) for the selected period (local time). */
function computeRange(period: EnergyPeriod, ref: Date): { from: Date; to: Date } {
  const from = new Date(ref);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);

  if (period === 'day') {
    to.setDate(to.getDate() + 1);
  } else if (period === 'week') {
    // week starts on Monday
    const day = (from.getDay() + 6) % 7; // Mon=0 .. Sun=6
    from.setDate(from.getDate() - day);
    to.setTime(from.getTime());
    to.setDate(to.getDate() + 7);
  } else {
    // month
    from.setDate(1);
    to.setTime(from.getTime());
    to.setMonth(to.getMonth() + 1);
  }
  return { from, to };
}
