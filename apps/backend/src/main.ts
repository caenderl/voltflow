import { Logger } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { AllExceptionsFilter } from './app/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // In Prod liefert nginx Frontend + API same-origin (CORS nicht nötig).
  // Im Dev läuft Angular auf :4200 -> nur diese Origin erlauben (per Env überschreibbar).
  app.enableCors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200' });
  // Globaler Exception-Filter: einheitliches Logging + saubere Fehler-Antworten
  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));
  // Sauberes Herunterfahren (onModuleDestroy -> DB-Verbindungen schließen)
  app.enableShutdownHooks();
  const globalPrefix = 'api';
  app.setGlobalPrefix(globalPrefix);
  const port = process.env.PORT || 3000;
  await app.listen(port);
  Logger.log(
    `🚀 Application is running on: http://localhost:${port}/${globalPrefix}`,
  );
}

bootstrap().catch((err) => {
  Logger.error(`Bootstrap fehlgeschlagen: ${err}`, (err as Error)?.stack);
  process.exit(1);
});
