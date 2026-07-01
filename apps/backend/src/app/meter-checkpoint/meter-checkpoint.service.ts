import { Injectable, NotFoundException } from '@nestjs/common';
import type { MeterCheckpoint, MeterCheckpointInput } from '@org/shared-types';
import { DbService } from '../database/db.service';

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
