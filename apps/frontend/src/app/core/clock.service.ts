import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** How often "now" is re-published. Fine enough for a staleness badge. */
const TICK_MS = 10_000;

/**
 * A signal that re-emits every {@link TICK_MS}, so a `computed()` whose result
 * depends on the current time re-evaluates on its own.
 *
 * `computed()` only re-runs when a *tracked* signal it read changes, and a bare
 * `Date.now()` inside one is invisible to Angular's reactivity — without a
 * ticking dependency, a tab left open keeps showing a pre-midnight "can I page
 * forward?" answer, or a live card that went stale hours ago. Call `now()`
 * inside the computed to establish the dependency and use its value as the
 * clock, so the dependency cannot be mistaken for a stray statement and
 * deleted.
 *
 * Root-provided rather than a module-level `setInterval` so it is injectable
 * (tests substitute it), and so the timer is tied to the injector's lifetime
 * instead of running for as long as the bundle is loaded.
 */
@Injectable({ providedIn: 'root' })
export class ClockService {
  private readonly tick = signal(Date.now());

  constructor() {
    const id = setInterval(() => this.tick.set(Date.now()), TICK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  /** Current epoch ms, refreshed every {@link TICK_MS}. */
  now(): number {
    return this.tick();
  }
}
