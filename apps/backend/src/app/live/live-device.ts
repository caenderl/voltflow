/**
 * Describes one device's live channel as plain data: which pg NOTIFY channel
 * feeds it, how to map a NOTIFY row to a reading, which socket.io event carries
 * it to clients, and how to fetch the latest value for a freshly connected
 * client. The gateway iterates these descriptors instead of knowing each device
 * service by name — adding a device is one more descriptor, no gateway change.
 */
export interface LiveDeviceDescriptor<R = unknown> {
  /** socket.io event name pushed to clients. */
  event: string;
  /** pg NOTIFY channel this device publishes on. */
  notifyChannel: string;
  /** NOTIFY payload row (snake_case) -> typed reading. */
  map: (row: Record<string, unknown>) => R;
  /** Latest known value, sent to a newly connected client right away. */
  latest: () => Promise<R | null>;
}

/** DI token for the assembled list of live device descriptors. */
export const LIVE_DEVICES = Symbol('LIVE_DEVICES');
