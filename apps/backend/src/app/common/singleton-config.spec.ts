import { describe, expect, it } from 'vitest';
import type { DbService } from '../database/db.service';
import {
  SingletonConfigStore,
  asBool,
  asNumber,
  asStringOrNull,
} from './singleton-config';

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
