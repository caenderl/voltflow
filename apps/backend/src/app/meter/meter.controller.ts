import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type {
  EnergyPeriod,
  EnergySummary,
  MeterReading,
  SeriesResolution,
  SeriesResponse,
} from '@org/shared-types';
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

  @Get('series')
  series(
    @Query('from') fromStr?: string,
    @Query('to') toStr?: string,
    @Query('resolution') resolution?: string,
  ): Promise<SeriesResponse> {
    const to = toStr ? new Date(toStr) : new Date();
    const from = fromStr
      ? new Date(fromStr)
      : new Date(to.getTime() - 60 * 60 * 1000); // Default: letzte Stunde
    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      throw new BadRequestException('Ungültige from/to-Zeitangabe.');
    }
    const res = (resolution ?? '1min') as SeriesResolution;
    if (!RESOLUTIONS.includes(res)) {
      throw new BadRequestException(`resolution muss eine von ${RESOLUTIONS}`);
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
      throw new BadRequestException(`period muss eine von ${PERIODS}`);
    }
    const ref = dateStr ? new Date(dateStr) : new Date();
    if (isNaN(ref.getTime())) {
      throw new BadRequestException('Ungültiges date.');
    }
    const { from, to } = computeRange(period, ref);
    return this.meter.energy(period, from, to);
  }
}

/** Liefert [from, to) für den gewählten Zeitraum (lokale Zeit). */
function computeRange(period: EnergyPeriod, ref: Date): { from: Date; to: Date } {
  const from = new Date(ref);
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);

  if (period === 'day') {
    to.setDate(to.getDate() + 1);
  } else if (period === 'week') {
    // Woche beginnt Montag
    const day = (from.getDay() + 6) % 7; // Mo=0 .. So=6
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
