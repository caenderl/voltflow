import { Controller, Get } from '@nestjs/common';
import type { DeviceInfo } from '@org/shared-types';
import { DevicesService } from './devices.service';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** Every device that has ever reported, with its roles. */
  @Get()
  list(): Promise<DeviceInfo[]> {
    return this.devices.list();
  }
}
