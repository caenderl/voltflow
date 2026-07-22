import { Injectable, NotFoundException } from '@nestjs/common';
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
 * Local time of day a checkpoint is assumed to have been read at. Readings
 * happen in the late afternoon, so anchoring here keeps the gap between the
 * hand-read value and its smart meter counterpart to a couple of hours.
 */
const READ_TIME = '18:00';

/**
 * How far before {@link READ_TIME} a smart meter sample may lie. Wide enough to
 * survive a short collector gap, narrow enough that a longer outage surfaces as
 * "no-data" instead of silently passing off a morning value as the reading.
 */
const READ_WINDOW = '3 hours';

@Injectable()
export class MeterCheckpointService {
  constructor(private readonly db: DbService) {}

  async list(): Promise<MeterCheckpoint[]> {
    const { rows } = await this.db.query(
      `SELECT id, date::text, import_kwh, export_kwh, created_at
         FROM meter_checkpoint
        ORDER BY date DESC, id DESC`,
    );
    return rows.map(rowToCheckpoint);
  }

  async create(input: MeterCheckpointInput): Promise<MeterCheckpoint> {
    const { rows } = await this.db.query(
      `INSERT INTO meter_checkpoint (date, import_kwh, export_kwh)
       VALUES ($1, $2, $3)
       RETURNING id, date::text, import_kwh, export_kwh, created_at`,
      [input.date, input.importKwh, input.exportKwh],
    );
    return rowToCheckpoint(rows[0]);
  }

  async update(id: number, input: MeterCheckpointInput): Promise<MeterCheckpoint> {
    const { rows } = await this.db.query(
      `UPDATE meter_checkpoint
          SET date = $2, import_kwh = $3, export_kwh = $4
        WHERE id = $1
        RETURNING id, date::text, import_kwh, export_kwh, created_at`,
      [id, input.date, input.importKwh, input.exportKwh],
    );
    if (!rows.length) throw new NotFoundException(`Checkpoint ${id} not found`);
    return rowToCheckpoint(rows[0]);
  }

  /**
   * Compare the hand-read checkpoints against the smart meter's own cumulative
   * counters, and extrapolate today's physical reading from the newest one.
   *
   * A checkpoint carries a date but no time, so its smart meter counterpart is
   * the counter as of {@link READ_TIME} on that local day. For the interval
   * comparison the exact anchor barely matters — a constant offset cancels
   * between the two ends — but the projection has no second end to cancel
   * against, so anchoring near the actual reading time keeps it honest.
   *
   * `meter_1hour` is the source because the raw readings are dropped after 30
   * days while the aggregates are kept long-term. Its buckets are whole hours,
   * which line up with the local hour (Europe/Berlin offsets are whole hours).
   */
  async reconciliation(): Promise<MeterReconciliation> {
    const { rows } = await this.db.query(
      `SELECT c.date::text AS date, c.import_kwh, c.export_kwh,
              s.grid_import_energy AS counter_import,
              s.grid_export_energy AS counter_export
         FROM meter_checkpoint c
         LEFT JOIN LATERAL (
           SELECT grid_import_energy, grid_export_energy
             FROM meter_1hour
            WHERE bucket <  ((c.date + $2::time) AT TIME ZONE $1)
              AND bucket >= ((c.date + $2::time) AT TIME ZONE $1) - $3::interval
              AND grid_import_energy IS NOT NULL
              AND grid_export_energy IS NOT NULL
            ORDER BY bucket DESC
            LIMIT 1
         ) s ON TRUE
        ORDER BY c.date, c.id`,
      [TIMEZONE, READ_TIME, READ_WINDOW],
    );

    const samples: CheckpointSample[] = rows.map((r) => ({
      date: String(r['date']),
      importKwh: Number(r['import_kwh']),
      exportKwh: Number(r['export_kwh']),
      counterImportKwh: numOrNull(r['counter_import']),
      counterExportKwh: numOrNull(r['counter_export']),
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

function rowToCheckpoint(r: Record<string, unknown>): MeterCheckpoint {
  return {
    id: Number(r['id']),
    date: String(r['date']),
    importKwh: Number(r['import_kwh']),
    exportKwh: Number(r['export_kwh']),
    createdAt: new Date(r['created_at'] as string).toISOString(),
  };
}
