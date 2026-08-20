import { signal } from '@angular/core';

/**
 * Ticks every 10s so a `computed()` that depends on "now" (a canNext/canPrev
 * gate that flips at midnight/New Year's Eve, or a live-reading staleness
 * check) re-evaluates on its own. `computed()` only re-runs when a *tracked*
 * signal it read changes — a bare `new Date()`/`Date.now()` inside one is
 * invisible to Angular's reactivity, so without this, a long-lived tab keeps
 * showing a stale result until some unrelated signal happens to write. Read
 * (not just imported) inside the computed to establish the dependency; the
 * value itself is irrelevant.
 */
export const clockTick = signal(Date.now());

if (typeof window !== 'undefined') {
  setInterval(() => clockTick.set(Date.now()), 10_000);
}
