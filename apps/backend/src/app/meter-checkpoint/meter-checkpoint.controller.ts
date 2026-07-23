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
import type {
  MeterCheckpoint,
  MeterCheckpointInput,
  MeterReconciliation,
} from '@org/shared-types';
import { MeterCheckpointService } from './meter-checkpoint.service';

@Controller('meter-checkpoints')
export class MeterCheckpointController {
  constructor(private readonly checkpoints: MeterCheckpointService) {}

  @Get()
  list(): Promise<MeterCheckpoint[]> {
    return this.checkpoints.list();
  }

  /** Checkpoints vs. the smart meter's own counters + today's projection. */
  @Get('reconciliation')
  reconciliation(): Promise<MeterReconciliation> {
    return this.checkpoints.reconciliation();
  }

  @Post()
  create(@Body() body: Partial<MeterCheckpointInput>): Promise<MeterCheckpoint> {
    return this.checkpoints.create(parseInput(body));
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Partial<MeterCheckpointInput>,
  ): Promise<MeterCheckpoint> {
    return this.checkpoints.update(id, parseInput(body));
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.checkpoints.remove(id);
  }
}

function parseInput(body: Partial<MeterCheckpointInput>): MeterCheckpointInput {
  const date = body.date ? String(body.date).slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new BadRequestException('date must be a YYYY-MM-DD string');
  }
  return {
    date,
    readAt: parseReadAt(body.readAt),
    importKwh: parseNonNegative(body.importKwh, 'importKwh'),
    exportKwh: parseNonNegative(body.exportKwh, 'exportKwh'),
  };
}

/**
 * Time of day the meter was read (HH:MM). Required: the reconciliation looks up
 * the smart meter at this exact moment, so a missing value cannot be guessed.
 * Browsers send HH:MM:SS once seconds are involved — accept it, store HH:MM.
 */
export function parseReadAt(value: unknown): string {
  const match = /^(\d{2}):(\d{2})(:\d{2})?$/.exec(String(value ?? ''));
  const hours = match ? Number(match[1]) : NaN;
  const minutes = match ? Number(match[2]) : NaN;
  if (!match || hours > 23 || minutes > 59) {
    throw new BadRequestException('readAt must be a HH:MM time of day');
  }
  return `${match[1]}:${match[2]}`;
}

function parseNonNegative(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new BadRequestException(`${field} must be a non-negative number`);
  }
  return n;
}
