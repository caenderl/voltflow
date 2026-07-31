import { Controller, Get } from '@nestjs/common';
import type { BackupStatus, SystemHealth } from '@org/shared-types';
import { BackupService } from './backup.service';
import { SystemService } from './system.service';

@Controller('system')
export class SystemController {
  constructor(
    private readonly system: SystemService,
    private readonly backups: BackupService,
  ) {}

  /** Point-in-time host health snapshot (load / memory / disk / containers). */
  @Get('health')
  health(): Promise<SystemHealth> {
    return this.system.getHealth();
  }

  /** On-host dumps + off-site restic status. Changes daily, not polled. */
  @Get('backups')
  backupStatus(): Promise<BackupStatus> {
    return this.backups.getStatus();
  }
}
