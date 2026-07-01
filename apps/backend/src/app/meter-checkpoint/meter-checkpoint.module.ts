import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MeterCheckpointController } from './meter-checkpoint.controller';
import { MeterCheckpointService } from './meter-checkpoint.service';

@Module({
  imports: [DatabaseModule],
  controllers: [MeterCheckpointController],
  providers: [MeterCheckpointService],
})
export class MeterCheckpointModule {}
