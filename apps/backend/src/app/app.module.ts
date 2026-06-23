import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MeterModule } from './meter/meter.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), MeterModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
