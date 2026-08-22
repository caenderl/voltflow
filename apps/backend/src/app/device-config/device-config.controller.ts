import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import {
  CONFIGURABLE_DRIVERS,
  type DeviceConfig,
  type DeviceConfigCreateInput,
  type DeviceConfigInput,
  type DeviceDriver,
} from '@org/shared-types';
import { emptyToNull, parseIntInRange } from '../common/query-params';
import { DeviceConfigService } from './device-config.service';

@Controller('device-configs')
export class DeviceConfigController {
  constructor(private readonly configs: DeviceConfigService) {}

  @Get()
  list(): Promise<DeviceConfig[]> {
    return this.configs.list();
  }

  @Post()
  create(@Body() body: Partial<DeviceConfigCreateInput>): Promise<DeviceConfig> {
    const driver = parseDriver(body.driver);
    const input = parseInput(body);
    assertHostWhenEnabled(input);
    return this.configs.create({ driver, ...input });
  }

  @Put(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Partial<DeviceConfigInput>,
  ): Promise<DeviceConfig> {
    const input = parseInput(body);
    assertHostWhenEnabled(input);
    return this.configs.update(id, input);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.configs.remove(id);
  }
}

function parseDriver(value: unknown): DeviceDriver {
  if (
    typeof value === 'string' &&
    (CONFIGURABLE_DRIVERS as readonly string[]).includes(value)
  ) {
    return value as DeviceDriver;
  }
  throw new BadRequestException(
    `driver must be one of: ${CONFIGURABLE_DRIVERS.join(', ')}`,
  );
}

/**
 * Parses the fields shared by create and update. `port`/`unitId` are parsed
 * unconditionally (with Modbus's own defaults/ranges) regardless of which
 * driver the row ends up as - harmless, since the service's SQL nulls them
 * out for anything that is not `anker-v1-modbus` no matter what is passed in.
 */
function parseInput(body: Partial<DeviceConfigInput>): DeviceConfigInput {
  return {
    name: emptyToNull(body.name),
    enabled: Boolean(body.enabled),
    host: emptyToNull(body.host),
    port: parseIntInRange(body.port, 'port', 1, 65535, 502),
    unitId: parseIntInRange(body.unitId, 'unitId', 0, 255, 1),
    pollIntervalS: parseIntInRange(body.pollIntervalS, 'pollIntervalS', 5, 3600, 60),
  };
}

function assertHostWhenEnabled(input: DeviceConfigInput): void {
  if (input.enabled && !input.host) {
    throw new BadRequestException('host is required when enabled is true');
  }
}
