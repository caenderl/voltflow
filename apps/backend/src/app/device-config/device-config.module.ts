import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { DeviceConfigController } from './device-config.controller';
import { DeviceConfigService } from './device-config.service';

@Module({
  imports: [DatabaseModule],
  controllers: [DeviceConfigController],
  providers: [DeviceConfigService],
})
export class DeviceConfigModule {}
