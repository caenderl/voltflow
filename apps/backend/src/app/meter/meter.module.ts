import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { MeterController } from './meter.controller';
import { MeterGateway } from './meter.gateway';
import { MeterService } from './meter.service';
import { TariffController } from './tariff.controller';
import { TariffService } from './tariff.service';
import { WallboxController } from './wallbox.controller';
import { WallboxGateway } from './wallbox.gateway';
import { WallboxService } from './wallbox.service';

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
