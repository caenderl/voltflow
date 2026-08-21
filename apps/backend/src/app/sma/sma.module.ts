import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SmaController } from './sma.controller';
import { SmaService } from './sma.service';

@Module({
  imports: [DatabaseModule],
  controllers: [SmaController],
  providers: [SmaService],
  exports: [SmaService],
})
export class SmaModule {}
