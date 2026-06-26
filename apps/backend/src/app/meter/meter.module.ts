import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MeterController } from './meter.controller';
import { MeterGateway } from './meter.gateway';
import { MeterService } from './meter.service';

@Module({
  imports: [DatabaseModule],
  controllers: [MeterController],
  providers: [MeterService, MeterGateway],
})
export class MeterModule {}
