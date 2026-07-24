import { describe, expect, it } from 'vitest';
import { type CheckpointSample, computeReconciliation } from './reconciliation';

/** Checkpoint with matching smart meter counters (offset zero point). */
const sample = (
  date: string,
  importKwh: number,
  exportKwh: number,
  counterImportKwh: number | null = importKwh - 40000,
  counterExportKwh: number | null = exportKwh - 50000,
  // Does not enter the arithmetic — the reading time is resolved in SQL, which
  // hands this function the counters that already belong to that moment. It is
  // only carried through to the interval so the UI can show the anchor.
  readAt = '18:00',
  // Whether SQL had to fall back to an older bucket for this checkpoint.
  counterStale = false,
): CheckpointSample => ({
  date,
  readAt,
  importKwh,
  exportKwh,
  counterImportKwh,
  counterExportKwh,
  counterStale,
});

describe('computeReconciliation', () => {
  it('compares consecutive checkpoints as counter deltas', () => {
    // physical +100 import / +200 export; smart meter counted exactly the same
    const r = computeReconciliation(
      [sample('2026-06-01', 42000, 51000), sample('2026-07-01', 42100, 51200)],
      null,
    );

    expect(r.intervals).toHaveLength(1);
    const [i] = r.intervals;
    expect(i.status).toBe('ok');
    expect(i.days).toBe(30);
    expect(i.meterImportKwh).toBe(100);
    expect(i.smartImportKwh).toBe(100);
    expect(i.importDeviationKwh).toBe(0);
    expect(i.importDeviationPct).toBe(0);
    expect(i.meterExportKwh).toBe(200);
    expect(i.exportDeviationKwh).toBe(0);
  });

  it('carries both reading times into the interval', () => {
    // The dates alone do not say what was compared: each end was sampled at its
    // own time of day, and the UI has to be able to show which.
    const r = computeReconciliation(
      [
        sample('2026-06-01', 42000, 51000, undefined, undefined, '18:00'),
        sample('2026-07-01', 42100, 51200, undefined, undefined, '13:00'),
      ],
      null,
    );

    const [i] = r.intervals;
    expect(i.fromReadAt).toBe('18:00');
    expect(i.toReadAt).toBe('13:00');
  });

  it('flags an interval as approximate when either endpoint used a stale counter', () => {
    const fresh = () =>
      computeReconciliation(
        [sample('2026-06-01', 42000, 51000), sample('2026-07-01', 42100, 51200)],
        null,
      ).intervals[0];
    expect(fresh().approximate).toBe(false);

    // Second checkpoint's counter fell back to an older bucket -> the whole
    // delta is approximate, even though the comparison itself still succeeds.
    const staleEnd = computeReconciliation(
      [
        sample('2026-06-01', 42000, 51000),
        sample('2026-07-01', 42100, 51200, undefined, undefined, '18:00', true),
      ],
      null,
    ).intervals[0];
    expect(staleEnd.status).toBe('ok');
    expect(staleEnd.approximate).toBe(true);
  });

  it('reports a smart meter that undercounts as a negative deviation', () => {
    // physical +100, smart meter only counted 98 -> -2 kWh / -2 %
    const r = computeReconciliation(
      [
        sample('2026-06-01', 42000, 51000, 2000, 1000),
        sample('2026-07-01', 42100, 51200, 2098, 1200),
      ],
      null,
    );

    const [i] = r.intervals;
    expect(i.smartImportKwh).toBe(98);
    expect(i.importDeviationKwh).toBe(-2);
    expect(i.importDeviationPct).toBe(-2);
    // export matched exactly
    expect(i.exportDeviationPct).toBe(0);
  });

  it('marks an interval without smart meter data as no-data', () => {
    const r = computeReconciliation(
      [sample('2026-06-01', 42000, 51000, null, null), sample('2026-07-01', 42100, 51200)],
      null,
    );

    const [i] = r.intervals;
    expect(i.status).toBe('no-data');
    expect(i.smartImportKwh).toBeNull();
    expect(i.importDeviationKwh).toBeNull();
    // the physical delta is still known
    expect(i.meterImportKwh).toBe(100);
    expect(r.totals).toBeNull();
  });

  it('marks a backwards counter jump as reset without deriving a deviation', () => {
    // smart meter was swapped: its counter restarted near zero
    const r = computeReconciliation(
      [
        sample('2026-06-01', 42000, 51000, 2000, 1000),
        sample('2026-07-01', 42100, 51200, 50, 20),
      ],
      null,
    );

    const [i] = r.intervals;
    expect(i.status).toBe('reset');
    expect(i.smartImportKwh).toBe(-1950); // kept visible, the jump is a fact
    expect(i.importDeviationKwh).toBeNull();
    expect(i.importDeviationPct).toBeNull();
    expect(r.totals).toBeNull();
  });

  it('combines only comparable intervals into the totals and factors', () => {
    const r = computeReconciliation(
      [
        sample('2026-05-01', 41800, 50600, null, null), // no data -> excluded
        sample('2026-06-01', 42000, 51000, 2000, 1000),
        sample('2026-07-01', 42100, 51200, 2098, 1200), // -2 kWh import
        sample('2026-08-01', 42300, 51500, 2296, 1500), // -2 kWh import
      ],
      null,
    );

    expect(r.intervals).toHaveLength(3);
    const t = r.totals;
    expect(t).not.toBeNull();
    expect(t?.intervalCount).toBe(2);
    expect(t?.skippedCount).toBe(1);
    // 30 (Jun) + 31 (Jul) days -- the two comparable intervals only
    expect(t?.days).toBe(61);
    expect(t?.meterImportKwh).toBe(300);
    expect(t?.smartImportKwh).toBe(296);
    expect(t?.importDeviationKwh).toBe(-4);
    // 300 / 296 -> scale a smart meter delta up by ~1.35 %
    expect(t?.importFactor).toBe(1.0135);
    expect(t?.exportFactor).toBe(1);
  });

  it('counts only measured days when a gap is sandwiched between comparable intervals', () => {
    // One unreadable checkpoint knocks out the two intervals around it, so the
    // comparable ones are not contiguous. The totals must then describe the
    // measured days (4 + 2), not the 30-day outer span -- the kWh sums shown
    // next to them cover only those 6 days.
    const r = computeReconciliation(
      [
        sample('2026-06-01', 42000, 51000, 2000, 1000),
        sample('2026-06-05', 42020, 51010, 2020, 1010), // ok, 4 days
        sample('2026-06-25', 42200, 51100, null, null), // unreadable day
        sample('2026-06-29', 42260, 51130, 2240, 1120), // ok interval resumes after it
        sample('2026-07-01', 42280, 51140, 2260, 1130), // ok, 2 days
      ],
      null,
    );

    const t = r.totals;
    expect(t?.intervalCount).toBe(2);
    expect(t?.skippedCount).toBe(2); // both intervals touching the bad checkpoint
    expect(t?.days).toBe(6); // 4 + 2, not the 30-day span from 01.06 to 01.07
    expect(t?.meterImportKwh).toBe(40); // 20 + 20, matching those 6 days
  });

  it('projects the current reading from the newest usable checkpoint', () => {
    const r = computeReconciliation(
      [sample('2026-07-01', 42679, 51529, 2000, 1000)],
      { time: '2026-07-21T10:00:00.000Z', importKwh: 2150, exportKwh: 1080 },
    );

    const p = r.projection;
    expect(p?.baseDate).toBe('2026-07-01');
    expect(p?.asOf).toBe('2026-07-21T10:00:00.000Z');
    expect(p?.sinceImportKwh).toBe(150);
    expect(p?.importKwh).toBe(42829); // 42679 + 150
    expect(p?.exportKwh).toBe(51609); // 51529 + 80
    // a single checkpoint yields no interval, so there is no factor to apply
    expect(p?.calibratedImportKwh).toBeNull();
  });

  it('applies the learned factor to the projection when one exists', () => {
    const r = computeReconciliation(
      [
        sample('2026-06-01', 42000, 51000, 2000, 1000),
        sample('2026-07-01', 42100, 51200, 2098, 1200), // smart meter -2 %
      ],
      { time: '2026-07-21T10:00:00.000Z', importKwh: 2198, exportKwh: 1300 },
    );

    const p = r.projection;
    expect(p?.baseDate).toBe('2026-07-01');
    expect(p?.sinceImportKwh).toBe(100);
    expect(p?.importKwh).toBe(42200);
    // 100 kWh measured short by ~2 % -> 42100 + 100 * (100/98)
    expect(p?.calibratedImportKwh).toBe(42202.04);
  });

  it('skips checkpoints without counters when picking the projection base', () => {
    const r = computeReconciliation(
      [
        sample('2026-06-01', 42000, 51000, 2000, 1000),
        sample('2026-07-01', 42100, 51200, null, null),
      ],
      { time: '2026-07-21T10:00:00.000Z', importKwh: 2150, exportKwh: 1080 },
    );

    expect(r.projection?.baseDate).toBe('2026-06-01');
    expect(r.projection?.importKwh).toBe(42150);
  });

  it('returns no projection without checkpoints, data or after a reset', () => {
    expect(computeReconciliation([], { time: 'x', importKwh: 1, exportKwh: 1 }).projection)
      .toBeNull();
    expect(computeReconciliation([sample('2026-07-01', 42000, 51000)], null).projection)
      .toBeNull();
    // counter now lower than at the checkpoint -> reset in between
    const afterReset = computeReconciliation([sample('2026-07-01', 42000, 51000, 2000, 1000)], {
      time: '2026-07-21T10:00:00.000Z',
      importKwh: 50,
      exportKwh: 20,
    });
    expect(afterReset.projection).toBeNull();
  });

  it('returns empty results for a single checkpoint', () => {
    const r = computeReconciliation([sample('2026-07-01', 42000, 51000)], null);
    expect(r.intervals).toEqual([]);
    expect(r.totals).toBeNull();
  });
});
