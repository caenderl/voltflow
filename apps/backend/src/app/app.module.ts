import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MeterModule } from './meter/meter.module';
import { TariffModule } from './tariff/tariff.module';
import { WallboxModule } from './wallbox/wallbox.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MeterModule,
    TariffModule,
    WallboxModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
