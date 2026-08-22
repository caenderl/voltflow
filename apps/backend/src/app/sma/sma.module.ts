import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SmaService } from './sma.service';

/** No controller: the inverters' live readings go out over the WebSocket, and
 *  their energy figures are served by the energy module under their role. */
@Module({
  imports: [DatabaseModule],
  providers: [SmaService],
  exports: [SmaService],
})
export class SmaModule {}
