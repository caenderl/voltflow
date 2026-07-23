import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { TariffPeriodController } from './tariff-period.controller';
import { TariffPeriodService } from './tariff-period.service';

@Module({
  imports: [DatabaseModule],
  controllers: [TariffPeriodController],
  providers: [TariffPeriodService],
})
export class TariffPeriodModule {}
