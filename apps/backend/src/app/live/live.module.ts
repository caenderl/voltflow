import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MeterModule } from '../meter/meter.module';
import { MeterService } from '../meter/meter.service';
import { meterLiveDescriptor } from '../meter/meter.live';
import { SmaModule } from '../sma/sma.module';
import { SmaService } from '../sma/sma.service';
import { smaLiveDescriptor } from '../sma/sma.live';
import { WallboxModule } from '../wallbox/wallbox.module';
import { WallboxService } from '../wallbox/wallbox.service';
import { wallboxLiveDescriptor } from '../wallbox/wallbox.live';
import { LIVE_DEVICES, type LiveDeviceDescriptor } from './live-device';
import { LiveGateway } from './live.gateway';

@Module({
  imports: [DatabaseModule, MeterModule, WallboxModule, SmaModule],
  providers: [
    LiveGateway,
    {
      // The device registry: one descriptor per device. Adding a device is one
      // more line here (plus its <device>.live.ts) — the gateway is untouched.
      provide: LIVE_DEVICES,
      inject: [MeterService, WallboxService, SmaService],
      useFactory: (
        meter: MeterService,
        wallbox: WallboxService,
        sma: SmaService,
      ): LiveDeviceDescriptor[] => [
        meterLiveDescriptor(meter),
        wallboxLiveDescriptor(wallbox),
        smaLiveDescriptor(sma),
      ],
    },
  ],
})
export class LiveModule {}
