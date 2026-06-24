import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { MeterController } from './meter.controller';
import { MeterGateway } from './meter.gateway';
import { MeterService } from './meter.service';
import { TariffController } from './tariff.controller';
import { TariffService } from './tariff.service';

@Module({
  controllers: [MeterController, TariffController],
  providers: [DbService, MeterService, MeterGateway, TariffService],
})
export class MeterModule {}
