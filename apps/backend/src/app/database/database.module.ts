import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { PgListenService } from './pg-listen.service';

/**
 * Shared database access: DbService (connection pool + idempotent schema
 * migrations) and PgListenService (pg LISTEN/NOTIFY live streams), used by
 * all feature modules.
 */
@Module({
  providers: [DbService, PgListenService],
  exports: [DbService, PgListenService],
})
export class DatabaseModule {}
