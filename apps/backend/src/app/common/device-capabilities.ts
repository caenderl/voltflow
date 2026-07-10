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

/** Reads the single most recent reading, or null when there is none yet. */
export interface HasLatest<R> {
  latest(): Promise<R | null>;
}

/** Reports the [first, last] timestamp span of stored readings. */
export interface HasRange {
  range(): Promise<DataRange>;
}

/** Returns the raw readings in [from, to), oldest first. */
export interface HasHistory<R> {
  history(from: Date, to: Date): Promise<R[]>;
}

/** Reads and persists the device's single-row configuration. */
export interface Configurable<C> {
  getConfig(): Promise<C>;
  saveConfig(config: C): Promise<C>;
}
