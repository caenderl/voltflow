import type { DataRange } from '@org/shared-types';

/**
 * Capability interfaces ("ports") the device services implement. A service
 * implements the ones it actually supports — these describe only the *common*
 * shape, not the full repertoire. Device-specific queries (e.g. the PV minute
 * power or the meter series/resolution) deliberately stay off these interfaces;
 * they are unique to one device and forcing them into a generic contract would
 * only obscure them.
 *
 * Only {@link HasLatestPerDevice} currently has a polymorphic consumer: the
 * live gateway holds every device through it and never by concrete type. The
 * other two have a single implementer each after the endpoints nothing called
 * were removed — they stay as named contracts so the next device has a shape to
 * match rather than inventing its own signature, not because anything consumes
 * them generically today.
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
