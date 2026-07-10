import { Controller, Get } from '@nestjs/common';
import type { SystemHealth } from '@org/shared-types';
import { SystemService } from './system.service';

@Controller('system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  /** Point-in-time host health snapshot (load / memory / disk / containers). */
  @Get('health')
  health(): Promise<SystemHealth> {
    return this.system.getHealth();
  }
}
