import { Module } from '@nestjs/common';
import { BackupService } from './backup.service';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';

/** Host monitoring for the admin "System" tab. No DB — reads the OS directly. */
@Module({
  controllers: [SystemController],
  providers: [SystemService, BackupService],
})
export class SystemModule {}
