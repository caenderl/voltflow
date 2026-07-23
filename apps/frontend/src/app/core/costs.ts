import type { EnergySummary, TariffPeriod } from '@org/shared-types';
import { toLocalDateString } from './date-utils';

/** Consumption cost, feed-in revenue and their net, all in €. */
export interface Costs {
  importCost: number;
  exportRevenue: number;
  net: number;
}

/** A period with both prices set — the only kind that can bill a bucket. */
function isPriced(
  p: TariffPeriod | undefined,
): p is TariffPeriod & { importCtPerKwh: number; exportCtPerKwh: number } {
  return p?.importCtPerKwh != null && p?.exportCtPerKwh != null;
}

/**
 * The tariff period in effect on a given local day: the latest whose `validFrom`
 * is on or before it. The oldest period extends backward, so a day before every
 * period still resolves to the earliest one (one price covers all prior data).
 * `periods` must be sorted ascending by `validFrom`.
 */
function periodOn(periodsAsc: TariffPeriod[], day: string): TariffPeriod | undefined {
  let chosen = periodsAsc[0];
  for (const p of periodsAsc) {
    if (p.validFrom <= day) chosen = p;
    else break;
  }
  return chosen;
}

/**
 * Bill an energy summary against time-ranged tariffs: each bucket is priced by
 * the tariff in effect on its day, so a period spanning a tariff change is split
 * correctly. When a single priced tariff covers the whole range, the accurate
 * range totals are billed instead of the summed buckets (which can drift from
 * them), keeping the figure hand-verifiable against the displayed kWh.
 *
 * Returns null when no bucket falls under a priced tariff — same "no prices set"
 * state the UI showed before, so nothing renders a bogus 0 €.
 */
export function computeCosts(
  energy: EnergySummary | null,
  periods: TariffPeriod[],
): Costs | null {
  if (!energy || !periods.length) return null;
  const asc = [...periods].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));

  let importCost = 0;
  let exportRevenue = 0;
  const usedIds = new Set<number>();
  let unpricedBuckets = 0;
  for (const b of energy.buckets) {
    const p = periodOn(asc, toLocalDateString(new Date(b.time)));
    if (!isPriced(p)) {
      unpricedBuckets++;
      continue;
    }
    usedIds.add(p.id);
    importCost += (b.importKwh * p.importCtPerKwh) / 100;
    exportRevenue += (b.exportKwh * p.exportCtPerKwh) / 100;
  }
  if (!usedIds.size) return null;

  // One priced tariff covered every bucket -> bill the exact range totals.
  if (usedIds.size === 1 && unpricedBuckets === 0) {
    const p = asc.find((x) => usedIds.has(x.id));
    if (isPriced(p)) {
      importCost = (energy.importKwh * p.importCtPerKwh) / 100;
      exportRevenue = (energy.exportKwh * p.exportCtPerKwh) / 100;
    }
  }

  return { importCost, exportRevenue, net: importCost - exportRevenue };
}
