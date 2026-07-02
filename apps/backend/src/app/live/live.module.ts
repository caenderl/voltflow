import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MeterModule } from '../meter/meter.module';
import { SmaModule } from '../sma/sma.module';
import { WallboxModule } from '../wallbox/wallbox.module';
import { LiveGateway } from './live.gateway';

@Module({
  imports: [DatabaseModule, MeterModule, WallboxModule, SmaModule],
  providers: [LiveGateway],
})
export class LiveModule {}
