import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MeterModule } from './meter/meter.module';
import { MeterCheckpointModule } from './meter-checkpoint/meter-checkpoint.module';
import { TariffModule } from './tariff/tariff.module';
import { WallboxModule } from './wallbox/wallbox.module';
import { SmaModule } from './sma/sma.module';
import { LiveModule } from './live/live.module';
import { SystemModule } from './system/system.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MeterModule,
    MeterCheckpointModule,
    TariffModule,
    WallboxModule,
    SmaModule,
    LiveModule,
    SystemModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
