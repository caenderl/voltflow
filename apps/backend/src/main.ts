/**
 * This is not a production server yet!
 * This is only a minimal backend to get started.
 */

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // In Prod liefert nginx Frontend + API same-origin (CORS nicht nötig).
  // Im Dev läuft Angular auf :4200 -> nur diese Origin erlauben (per Env überschreibbar).
  app.enableCors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200' });
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);
  const port = process.env.PORT || 3000;
  await app.listen(port);
  Logger.log(
    `🚀 Application is running on: http://localhost:${port}/${globalPrefix}`,
  );
}

bootstrap();
