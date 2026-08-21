import { describe, expect, it } from 'vitest';
import type { DbService } from '../database/db.service';
import {
  DriverConfigStore,
  SingletonConfigStore,
  asBool,
  asNumber,
  asStringOrNull,
} from './config-store';

interface TestConfig {
  enabled: boolean;
  host: string | null;
  pollIntervalS: number;
}

const COLUMNS = [
  { column: 'enabled', key: 'enabled' as const, fromDb: asBool },
  { column: 'host', key: 'host' as const, fromDb: asStringOrNull },
  { column: 'poll_interval_s', key: 'pollIntervalS' as const, fromDb: asNumber },
];

const DEFAULTS: TestConfig = { enabled: false, host: null, pollIntervalS: 60 };

/** Fake DbService recording queries and returning canned rows. */
function fakeDb(rows: Record<string, unknown>[]) {
  const calls: { text: string; params?: unknown[] }[] = [];
  const db = {
    query: (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return Promise.resolve({ rows });
    },
  } as unknown as DbService;
  return { db, calls };
}

describe('SingletonConfigStore', () => {
  it('get: returns defaults when no row exists yet', async () => {
    const { db } = fakeDb([]);
    const store = new SingletonConfigStore(db, 'test_config', COLUMNS, DEFAULTS);
    expect(await store.get()).toEqual(DEFAULTS);
  });

  it('get: maps DB values through the column converters', async () => {
    const { db, calls } = fakeDb([
      { enabled: true, host: 'device.local', poll_interval_s: '30' },
    ]);
    const store = new SingletonConfigStore(db, 'test_config', COLUMNS, DEFAULTS);
    expect(await store.get()).toEqual({
      enabled: true,
      host: 'device.local',
      pollIntervalS: 30, // pg numeric string -> number
    });
    expect(calls[0].text).toContain('FROM test_config WHERE id = 1');
  });

  it('get: SQL NULL becomes null via asStringOrNull', async () => {
    const { db } = fakeDb([{ enabled: false, host: null, poll_interval_s: 60 }]);
    const store = new SingletonConfigStore(db, 'test_config', COLUMNS, DEFAULTS);
    expect((await store.get()).host).toBeNull();
  });

  it('save: upserts row id 1 with all columns and re-reads', async () => {
    const { db, calls } = fakeDb([
      { enabled: true, host: 'h', poll_interval_s: 10 },
    ]);
    const store = new SingletonConfigStore(db, 'test_config', COLUMNS, DEFAULTS);
    const saved = await store.save({ enabled: true, host: 'h', pollIntervalS: 10 });

    const insert = calls[0];
    expect(insert.text).toContain(
      'INSERT INTO test_config (id, enabled, host, poll_interval_s, updated_at)',
    );
    expect(insert.text).toContain('VALUES (1, $1, $2, $3, now())');
    expect(insert.text).toContain('ON CONFLICT (id) DO UPDATE');
    expect(insert.params).toEqual([true, 'h', 10]);
    // save() returns the re-read state
    expect(saved).toEqual({ enabled: true, host: 'h', pollIntervalS: 10 });
    expect(calls).toHaveLength(2);
  });
});

/**
 * Fake DbService answering each call from a queue, because DriverConfigStore
 * issues two different queries per save (UPDATE ... RETURNING, then the
 * re-read) and the single-canned-row fake above cannot tell them apart.
 */
function fakeDbSeq(responses: Record<string, unknown>[][]) {
  const calls: { text: string; params?: unknown[] }[] = [];
  const queue = [...responses];
  const db = {
    query: (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      return Promise.resolve({ rows: queue.shift() ?? [] });
    },
  } as unknown as DbService;
  return { db, calls };
}

describe('DriverConfigStore', () => {
  const ROW = { enabled: true, host: 'device.local', poll_interval_s: '30' };
  const CONFIG: TestConfig = {
    enabled: true,
    host: 'device.local',
    pollIntervalS: 30,
  };

  it('get: returns defaults when the driver has no row yet', async () => {
    const { db } = fakeDbSeq([[]]);
    const store = new DriverConfigStore(db, 'sma-speedwire', COLUMNS, DEFAULTS);
    expect(await store.get()).toEqual(DEFAULTS);
  });

  it('get: selects by driver and maps through the converters', async () => {
    const { db, calls } = fakeDbSeq([[ROW]]);
    const store = new DriverConfigStore(db, 'sma-speedwire', COLUMNS, DEFAULTS);
    expect(await store.get()).toEqual(CONFIG);
    expect(calls[0].text).toContain('FROM device_config WHERE driver = $1');
    expect(calls[0].params).toEqual(['sma-speedwire']);
  });

  it('get: takes the lowest id, so the read is stable with several rows', async () => {
    const { db, calls } = fakeDbSeq([[ROW]]);
    const store = new DriverConfigStore(db, 'sma-speedwire', COLUMNS, DEFAULTS);
    await store.get();
    expect(calls[0].text).toContain('ORDER BY id LIMIT 1');
  });

  it('save: updates the existing row and does not insert', async () => {
    // UPDATE ... RETURNING id hits, then the re-read.
    const { db, calls } = fakeDbSeq([[{ id: 7 }], [ROW]]);
    const store = new DriverConfigStore(db, 'sma-speedwire', COLUMNS, DEFAULTS);
    const saved = await store.save(CONFIG);

    expect(calls).toHaveLength(2);
    expect(calls[0].text).toContain('UPDATE device_config');
    expect(calls[0].text).toContain('RETURNING id');
    expect(calls[0].params).toEqual([true, 'device.local', 30, 'sma-speedwire']);
    expect(calls.some((c) => c.text.includes('INSERT'))).toBe(false);
    expect(saved).toEqual(CONFIG);
  });

  it('save: throws instead of inserting when no row matched', async () => {
    // The seed migrations guarantee a row per driver, so "no row" is a bug,
    // not a case to paper over with an INSERT that a concurrent save could
    // duplicate (driver is not unique, so nothing would catch the duplicate).
    const { db, calls } = fakeDbSeq([[]]);
    const store = new DriverConfigStore(db, 'sma-speedwire', COLUMNS, DEFAULTS);

    await expect(store.save(CONFIG)).rejects.toThrow(
      /no device_config row for driver "sma-speedwire"/,
    );
    // one UPDATE attempt, nothing else - in particular no write
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => c.text.includes('INSERT'))).toBe(false);
  });

  it('save: has no write path other than the UPDATE', async () => {
    const { db, calls } = fakeDbSeq([[{ id: 7 }], [ROW]]);
    const store = new DriverConfigStore(db, 'sma-speedwire', COLUMNS, DEFAULTS);
    await store.save(CONFIG);
    expect(calls.some((c) => c.text.includes('INSERT'))).toBe(false);
    expect(calls.some((c) => c.text.includes('ON CONFLICT'))).toBe(false);
  });
});
