import { Module } from '@nestjs/common';
import { DbService } from './db.service';

/**
 * Shared database access: a single DbService (connection pool, idempotent
 * schema migrations and the pg LISTEN streams) used by all feature modules.
 */
@Module({
  providers: [DbService],
  exports: [DbService],
})
export class DatabaseModule {}
