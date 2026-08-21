import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MeterModule } from './meter/meter.module';
import { MeterCheckpointModule } from './meter-checkpoint/meter-checkpoint.module';
import { TariffPeriodModule } from './tariff-period/tariff-period.module';
import { BillingModule } from './billing/billing.module';
import { StatisticsModule } from './statistics/statistics.module';
import { AppSettingsModule } from './app-settings/app-settings.module';
import { WallboxModule } from './wallbox/wallbox.module';
import { SmaModule } from './sma/sma.module';
import { LiveModule } from './live/live.module';
import { SystemModule } from './system/system.module';
import { DevicesModule } from './devices/devices.module';
import { DeviceConfigModule } from './device-config/device-config.module';
import { EnergyModule } from './energy/energy.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MeterModule,
    MeterCheckpointModule,
    TariffPeriodModule,
    BillingModule,
    StatisticsModule,
    AppSettingsModule,
    WallboxModule,
    SmaModule,
    LiveModule,
    SystemModule,
    DevicesModule,
    DeviceConfigModule,
    EnergyModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
