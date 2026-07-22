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
    importKwh: parseNonNegative(body.importKwh, 'importKwh'),
    exportKwh: parseNonNegative(body.exportKwh, 'exportKwh'),
  };
}

function parseNonNegative(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new BadRequestException(`${field} must be a non-negative number`);
  }
  return n;
}
