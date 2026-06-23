import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

/**
 * Fängt ALLE unbehandelten Exceptions ab, loggt sie einheitlich und
 * antwortet mit sauberem JSON (statt rohem Stacktrace / generischem 500).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Internal server error';

    // 5xx mit Stacktrace, 4xx nur knapp loggen
    const path = httpAdapter.getRequestUrl(ctx.getRequest());
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${status} ${path}: ${(exception as Error)?.message ?? exception}`,
        (exception as Error)?.stack,
      );
    } else {
      this.logger.warn(`${status} ${path}: ${(exception as Error)?.message}`);
    }

    httpAdapter.reply(
      ctx.getResponse(),
      {
        statusCode: status,
        error: message,
        timestamp: new Date().toISOString(),
        path,
      },
      status,
    );
  }
}
