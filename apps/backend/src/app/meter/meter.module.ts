import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { MeterController } from './meter.controller';
import { MeterGateway } from './meter.gateway';
import { MeterService } from './meter.service';

@Module({
  controllers: [MeterController],
  providers: [DbService, MeterService, MeterGateway],
})
export class MeterModule {}
