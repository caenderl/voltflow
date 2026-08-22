import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { WallboxService } from './wallbox.service';

/** No controller — same reasoning as {@link SmaModule}. */
@Module({
  imports: [DatabaseModule],
  providers: [WallboxService],
  exports: [WallboxService],
})
export class WallboxModule {}
