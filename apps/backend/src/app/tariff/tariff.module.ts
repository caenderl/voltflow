import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { TariffController } from './tariff.controller';
import { TariffService } from './tariff.service';

@Module({
  imports: [DatabaseModule],
  controllers: [TariffController],
  providers: [TariffService],
})
export class TariffModule {}
