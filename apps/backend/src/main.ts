import { Logger } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { AllExceptionsFilter } from './app/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // In prod, nginx serves frontend + API same-origin (CORS not needed).
  // In dev, Angular runs on :4200 -> only allow that origin (overridable via env).
  app.enableCors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:4200' });
  // Global exception filter: consistent logging + clean error responses
  app.useGlobalFilters(new AllExceptionsFilter(app.get(HttpAdapterHost)));
  // Graceful shutdown (onModuleDestroy -> close DB connections)
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
  Logger.error(`Bootstrap failed: ${err}`, (err as Error)?.stack);
  process.exit(1);
});
