import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DRIVER_TRAITS,
  type DeviceConfig,
  type DeviceConfigCreateInput,
  type DeviceConfigInput,
  type DeviceDriver,
} from '@org/shared-types';
import { numOrNull } from '../common/db-utils';
import { DbService } from '../database/db.service';

const COLUMNS = `id, driver, name, enabled, host, port, unit_id, poll_interval_s, device_sn`;

/**
 * Drivers whose `port`/`unit_id` mean something, passed into the statements
 * below as an array parameter. Deriving it from the traits rather than writing
 * `driver = 'anker-v1-modbus'` into the SQL keeps a second Modbus device from
 * silently losing its port: it would be one more entry in DRIVER_TRAITS, and
 * the queries pick it up with no edit here.
 */
const MODBUS_DRIVERS: DeviceDriver[] = (
  Object.keys(DRIVER_TRAITS) as DeviceDriver[]
).filter((d) => DRIVER_TRAITS[d].usesModbus);

/**
 * CRUD over `device_config`: one row per configured device instance, the
 * successor to the old per-vendor singleton tables. `driver` is set once at
 * creation and never updated — see {@link DeviceConfigInput}.
 *
 * `port`/`unit_id` are nulled in SQL for any non-Modbus driver rather than
 * trusted from the request body, so the columns stay meaningless-for-SMA
 * regardless of what a client sends.
 */
@Injectable()
export class DeviceConfigService {
  constructor(private readonly db: DbService) {}

  async list(): Promise<DeviceConfig[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM device_config ORDER BY driver, id`,
    );
    return rows.map(rowToConfig);
  }

  async create(input: DeviceConfigCreateInput): Promise<DeviceConfig> {
    const { rows } = await this.db.query(
      `INSERT INTO device_config (driver, name, enabled, host, port, unit_id, poll_interval_s)
       VALUES ($1, $2, $3, $4,
               CASE WHEN $1 = ANY($8::text[]) THEN $5::int ELSE NULL END,
               CASE WHEN $1 = ANY($8::text[]) THEN $6::int ELSE NULL END,
               $7)
       RETURNING ${COLUMNS}`,
      [
        input.driver,
        input.name,
        input.enabled,
        input.host,
        input.port,
        input.unitId,
        input.pollIntervalS,
        MODBUS_DRIVERS,
      ],
    );
    return rowToConfig(rows[0]);
  }

  async update(id: number, input: DeviceConfigInput): Promise<DeviceConfig> {
    const { rows } = await this.db.query(
      `UPDATE device_config
          SET name = $2, enabled = $3, host = $4,
              port    = CASE WHEN driver = ANY($8::text[]) THEN $5::int ELSE NULL END,
              unit_id = CASE WHEN driver = ANY($8::text[]) THEN $6::int ELSE NULL END,
              poll_interval_s = $7,
              updated_at = now()
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [
        id,
        input.name,
        input.enabled,
        input.host,
        input.port,
        input.unitId,
        input.pollIntervalS,
        MODBUS_DRIVERS,
      ],
    );
    if (!rows.length) throw new NotFoundException(`device_config ${id} not found`);
    return rowToConfig(rows[0]);
  }

  /**
   * Deletes only the config row. `device` (the registry — what has been seen,
   * with its roles and history) is untouched: removing a config is "stop
   * managing this instance", not "this device never existed".
   */
  async remove(id: number): Promise<void> {
    const { rows } = await this.db.query(
      `DELETE FROM device_config WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!rows.length) throw new NotFoundException(`device_config ${id} not found`);
  }
}

function rowToConfig(r: Record<string, unknown>): DeviceConfig {
  return {
    id: Number(r['id']),
    driver: r['driver'] as DeviceConfig['driver'],
    name: (r['name'] as string | null) ?? null,
    enabled: Boolean(r['enabled']),
    host: (r['host'] as string | null) ?? null,
    port: numOrNull(r['port']),
    unitId: numOrNull(r['unit_id']),
    pollIntervalS: Number(r['poll_interval_s']),
    deviceSn: (r['device_sn'] as string | null) ?? null,
  };
}
