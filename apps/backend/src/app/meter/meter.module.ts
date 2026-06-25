import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { MeterController } from './meter/meter.controller';
import { MeterGateway } from './meter/meter.gateway';
import { MeterService } from './meter/meter.service';
import { TariffController } from './tariff/tariff.controller';
import { TariffService } from './tariff/tariff.service';
import { WallboxController } from './wallbox/wallbox.controller';
import { WallboxGateway } from './wallbox/wallbox.gateway';
import { WallboxService } from './wallbox/wallbox.service';

@Module({
  controllers: [MeterController, TariffController, WallboxController],
  providers: [
    DbService,
    MeterService,
    MeterGateway,
    TariffService,
    WallboxService,
    WallboxGateway,
  ],
})
export class MeterModule {}
