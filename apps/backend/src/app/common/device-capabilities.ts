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
 * Reads the single most recent reading, or null when there is none yet.
 *
 * `deviceSn` picks one device of this kind; without it the newest reading over
 * all of them is returned. That default is only unambiguous while exactly one
 * device of a kind is installed - with two it alternates between them, so any
 * caller that means a particular device has to name it.
 *
 * Implementations bind an empty `deviceSn` as `|| null` (falling back to the
 * "all devices" default), not `?? null`: a query string with the param present
 * but empty (`?deviceSn=`) parses to `''`, which `??` would pass straight
 * through to `device_sn = ''` and silently match no row. A serial number is
 * never the empty string, so treating `''` the same as "not given" is safe.
 */
export interface HasLatest<R> {
  latest(deviceSn?: string): Promise<R | null>;
}

/** Reports the [first, last] timestamp span of stored readings. */
export interface HasRange {
  range(): Promise<DataRange>;
}

/** Returns the raw readings in [from, to), oldest first. */
export interface HasHistory<R> {
  history(from: Date, to: Date): Promise<R[]>;
}
