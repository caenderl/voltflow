/**
 * German number/date formatting for the statistics cards.
 *
 * The cards take pre-formatted strings (they have no opinion on decimals), and
 * every figure they show is either absent or a plain number — so each helper
 * turns null into the same em dash instead of every template repeating the
 * check. Locale is fixed to de-DE, as everywhere else in the UI.
 */

const LOCALE = 'de-DE';
export const EM_DASH = '–';

function num(value: number | null | undefined, digits: number): string {
  if (value === null || value === undefined) return EM_DASH;
  return value.toLocaleString(LOCALE, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** "1.234" — power in W, no decimals (a watt of precision is plenty). */
export function formatWatts(value: number | null | undefined): string {
  return num(value, 0);
}

/** "30,86" — energy in kWh. */
export function formatKwh(value: number | null | undefined, digits = 2): string {
  return num(value, digits);
}

/** "30,86 kWh" — and just the dash when there is nothing, never "– kWh". */
export function formatKwhUnit(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined ? EM_DASH : `${num(value, digits)} kWh`;
}

/** A share (0..1) as "92 %". */
export function formatPercent(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined ? EM_DASH : `${num(value * 100, digits)} %`;
}

/** A local day ("2026-07-04") as "4. Juli 2026"; `short` gives "04.07.2026". */
export function formatDay(day: string | null | undefined, short = false): string {
  if (!day) return EM_DASH;
  // Parsed as UTC: the backend sends a calendar day, and every timezone the app
  // runs in is ahead of UTC, so midnight UTC lands on the same date.
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString(
    LOCALE,
    short
      ? { day: '2-digit', month: '2-digit', year: 'numeric' }
      : { day: 'numeric', month: 'long', year: 'numeric' },
  );
}

/** An instant as "4. Juli 2026, 11:35". */
export function formatMoment(iso: string | null | undefined): string {
  if (!iso) return EM_DASH;
  const d = new Date(iso);
  return `${d.toLocaleDateString(LOCALE, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })}, ${d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}`;
}
