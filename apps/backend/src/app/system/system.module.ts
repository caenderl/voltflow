import { Module } from '@nestjs/common';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';

/** Host monitoring for the admin "System" tab. No DB — reads the OS directly. */
@Module({
  controllers: [SystemController],
  providers: [SystemService],
})
export class SystemModule {}
