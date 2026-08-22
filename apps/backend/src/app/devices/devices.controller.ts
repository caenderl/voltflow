import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import { DEVICE_ROLES, type DeviceInfo, type DeviceRole } from '@org/shared-types';
import { DevicesService } from './devices.service';

@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** Every device that has ever reported, with its roles. */
  @Get()
  list(): Promise<DeviceInfo[]> {
    return this.devices.list();
  }

  /**
   * Correct what a device is in energy terms. The serial is the identity every
   * reading is tagged with, so it addresses the device directly rather than
   * through whichever config row currently points at it.
   */
  @Put(':deviceSn/roles')
  setRoles(
    @Param('deviceSn') deviceSn: string,
    @Body() body: { roles?: unknown },
  ): Promise<DeviceInfo> {
    return this.devices.setRoles(deviceSn, parseRoles(body.roles));
  }
}

function parseRoles(value: unknown): DeviceRole[] {
  if (!Array.isArray(value) || value.some((r) => !DEVICE_ROLES.includes(r as DeviceRole))) {
    throw new BadRequestException(`roles must be an array of: ${DEVICE_ROLES.join(', ')}`);
  }
  const roles = [...new Set(value as DeviceRole[])];
  // An empty array is rejected rather than stored, because it would not
  // survive: migration 062 resets `{}` to NULL (an empty array would otherwise
  // freeze a device as role-less forever, since the collector's COALESCE
  // seeding only fills a NULL), and the next registration would then re-seed
  // the driver's default. Storing it would look like it worked until the next
  // restart. "Count this device as nothing" is not expressible today.
  if (!roles.length) {
    throw new BadRequestException(
      'a device must carry at least one role; excluding a device from the ' +
        'energy balance is not supported',
    );
  }
  return roles;
}
