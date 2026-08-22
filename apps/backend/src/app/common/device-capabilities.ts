import type { DataRange } from '@org/shared-types';

/**
 * Capability interfaces ("ports") shared by the device services. A service
 * implements the ones it actually supports — these describe only the *common*
 * shape, not the full repertoire. Device-specific queries (e.g. the SMA energy
 * balance or the meter series/resolution) deliberately stay off these
 * interfaces; they are unique to one device and forcing them into a generic
 * contract would only obscure them.
 *
 * Implementing a capability is a compile-time promise (TypeScript enforces the
 * signature) and lets shared consumers — the live gateway, config endpoints —
 * treat any device through the port instead of by concrete type.
 */

/**
 * Reads the most recent reading OF EVERY DEVICE of this kind — one row per
 * `device_sn`, in no particular order, empty when nothing has been recorded.
 *
 * Deliberately not "the newest reading" singular, which is what this used to
 * be: with one device of a kind installed that is the same thing by accident,
 * and with two it returns whichever wrote last, so the live view would show one
 * device's values under whatever card happened to render. A device that has
 * been silent for a while still appears with its last known reading; judging
 * that as stale is the consumer's job, and a missing card is worse than an old
 * value that says how old it is.
 */
export interface HasLatestPerDevice<R> {
  latestPerDevice(): Promise<R[]>;
}

/** Reports the [first, last] timestamp span of stored readings. */
export interface HasRange {
  range(): Promise<DataRange>;
}

/** Returns the raw readings in [from, to), oldest first. */
export interface HasHistory<R> {
  history(from: Date, to: Date): Promise<R[]>;
}
