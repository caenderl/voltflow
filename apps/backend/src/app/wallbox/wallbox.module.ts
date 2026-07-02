import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { WallboxController } from './wallbox.controller';
import { WallboxService } from './wallbox.service';

@Module({
  imports: [DatabaseModule],
  controllers: [WallboxController],
  providers: [WallboxService],
  exports: [WallboxService],
})
export class WallboxModule {}
