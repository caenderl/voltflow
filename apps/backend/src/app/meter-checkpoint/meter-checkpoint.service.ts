import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  MeterCheckpoint,
  MeterCheckpointInput,
  MeterReconciliation,
} from '@org/shared-types';
import { TIMEZONE } from '../common/config';
import { numOrNull } from '../common/db-utils';
import { DbService } from '../database/db.service';
import {
  type CheckpointSample,
  type CounterSnapshot,
  computeReconciliation,
} from './reconciliation';

/**
 * How stale the smart meter value may be relative to the recorded reading time.
 * Wide enough to survive a short collector gap, narrow enough that a longer
 * outage surfaces as "no-data" instead of silently passing off a much older
 * counter as the reading.
 */
const READ_WINDOW = '3 hours';

/**
 * How far before the reading time the immediate hourly bucket can sit (buckets
 * are whole hours, so the one just before the reading is ≤ 1 h old). A counter
 * from further back means that immediate bucket was missing — the value is only
 * approximate, and the comparison says so.
 */
const EXACT_WINDOW = '1 hour';

/** Postgres unique_violation, raised by the one-checkpoint-per-date index. */
const UNIQUE_VIOLATION = '23505';

/** TIME renders as HH:MM:SS; the API contract is HH:MM. */
const READ_AT_TEXT = `to_char(read_at, 'HH24:MI') AS read_at`;

@Injectable()
export class MeterCheckpointService {
  constructor(private readonly db: DbService) {}

  async list(): Promise<MeterCheckpoint[]> {
    const { rows } = await this.db.query(
      `SELECT id, date::text, ${READ_AT_TEXT}, import_kwh, export_kwh, created_at
         FROM meter_checkpoint
        ORDER BY date DESC, id DESC`,
    );
    return rows.map(rowToCheckpoint);
  }

  async create(input: MeterCheckpointInput): Promise<MeterCheckpoint> {
    try {
      const { rows } = await this.db.query(
        `INSERT INTO meter_checkpoint (date, read_at, import_kwh, export_kwh)
         VALUES ($1, $2, $3, $4)
         RETURNING id, date::text, ${READ_AT_TEXT}, import_kwh, export_kwh, created_at`,
        [input.date, input.readAt, input.importKwh, input.exportKwh],
      );
      return rowToCheckpoint(rows[0]);
    } catch (err) {
      throw asDateConflict(err, input.date);
    }
  }

  async update(id: number, input: MeterCheckpointInput): Promise<MeterCheckpoint> {
    let rows;
    try {
      ({ rows } = await this.db.query(
        `UPDATE meter_checkpoint
            SET date = $2, read_at = $3, import_kwh = $4, export_kwh = $5
          WHERE id = $1
          RETURNING id, date::text, ${READ_AT_TEXT}, import_kwh, export_kwh, created_at`,
        [id, input.date, input.readAt, input.importKwh, input.exportKwh],
      ));
    } catch (err) {
      throw asDateConflict(err, input.date);
    }
    if (!rows.length) throw new NotFoundException(`Checkpoint ${id} not found`);
    return rowToCheckpoint(rows[0]);
  }

  /**
   * Compare the hand-read checkpoints against the smart meter's own cumulative
   * counters, and extrapolate today's physical reading from the newest one.
   *
   * Each checkpoint records when it was read, so its smart meter counterpart is
   * the last counter before that exact moment — nothing is assumed about the
   * time of day. A value older than {@link READ_WINDOW} is refused rather than
   * used, which surfaces a collector outage as "no-data".
   *
   * `meter_1hour` is the source because the raw readings are dropped after 30
   * days while the aggregates are kept long-term. Its buckets are whole hours,
   * which line up with the local hour (Europe/Berlin offsets are whole hours),
   * so the value is normally at most one hour older than the reading itself —
   * on a data gap it can fall back to an older bucket within {@link READ_WINDOW},
   * which is flagged via `counterStale`/`approximate` rather than assumed away.
   */
  async reconciliation(): Promise<MeterReconciliation> {
    const { rows } = await this.db.query(
      `SELECT c.date::text AS date, ${READ_AT_TEXT}, c.import_kwh, c.export_kwh,
              s.grid_import_energy AS counter_import,
              s.grid_export_energy AS counter_export,
              s.bucket < ((c.date + c.read_at) AT TIME ZONE $1) - $3::interval
                AS counter_stale
         FROM meter_checkpoint c
         LEFT JOIN LATERAL (
           SELECT grid_import_energy, grid_export_energy, bucket
             FROM meter_1hour
            WHERE bucket <  ((c.date + c.read_at) AT TIME ZONE $1)
              AND bucket >= ((c.date + c.read_at) AT TIME ZONE $1) - $2::interval
              AND grid_import_energy IS NOT NULL
              AND grid_export_energy IS NOT NULL
            ORDER BY bucket DESC
            LIMIT 1
         ) s ON TRUE
        ORDER BY c.date, c.read_at`,
      [TIMEZONE, READ_WINDOW, EXACT_WINDOW],
    );

    const samples: CheckpointSample[] = rows.map((r) => ({
      date: String(r['date']),
      readAt: String(r['read_at']),
      importKwh: Number(r['import_kwh']),
      exportKwh: Number(r['export_kwh']),
      counterImportKwh: numOrNull(r['counter_import']),
      counterExportKwh: numOrNull(r['counter_export']),
      // null (no bucket at all -> no-data) coerces to false, which is moot there.
      counterStale: Boolean(r['counter_stale']),
    }));

    return computeReconciliation(samples, await this.currentCounters());
  }

  /** The smart meter's latest cumulative counters, or null without readings. */
  private async currentCounters(): Promise<CounterSnapshot | null> {
    const { rows } = await this.db.query(
      `SELECT time, grid_import_energy, grid_export_energy
         FROM meter_reading
        WHERE grid_import_energy IS NOT NULL
          AND grid_export_energy IS NOT NULL
        ORDER BY time DESC
        LIMIT 1`,
    );
    if (!rows.length) return null;
    return {
      time: new Date(rows[0]['time'] as string).toISOString(),
      importKwh: Number(rows[0]['grid_import_energy']),
      exportKwh: Number(rows[0]['grid_export_energy']),
    };
  }

  async remove(id: number): Promise<void> {
    const { rows } = await this.db.query(
      `DELETE FROM meter_checkpoint WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!rows.length) throw new NotFoundException(`Checkpoint ${id} not found`);
  }
}

/**
 * Turn the unique-violation on the date index into a 409, so a second reading
 * for the same day reads as "already recorded" instead of a generic 500. Any
 * other error is passed through untouched.
 */
function asDateConflict(err: unknown, date: string): unknown {
  return (err as { code?: string } | null)?.code === UNIQUE_VIOLATION
    ? new ConflictException(`A checkpoint for ${date} already exists`)
    : err;
}

function rowToCheckpoint(r: Record<string, unknown>): MeterCheckpoint {
  return {
    id: Number(r['id']),
    date: String(r['date']),
    readAt: String(r['read_at']),
    importKwh: Number(r['import_kwh']),
    exportKwh: Number(r['export_kwh']),
    createdAt: new Date(r['created_at'] as string).toISOString(),
  };
}
