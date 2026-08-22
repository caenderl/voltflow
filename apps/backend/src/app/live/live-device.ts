/**
 * Describes one device KIND's live channel as plain data: which pg NOTIFY
 * channel feeds it, how to map a NOTIFY row to a reading, which socket.io event
 * carries it to clients, and how to fetch the current state for a freshly
 * connected client. The gateway iterates these descriptors instead of knowing
 * each device service by name — adding a device is one more descriptor, no
 * gateway change.
 *
 * One descriptor still covers every device of its kind: the channel carries all
 * of them and each reading names its own `deviceSn`, so two inverters share one
 * event rather than needing two channels. What is per-device is the *state*,
 * which is why the initial send is a list.
 */
export interface LiveDeviceDescriptor<R = unknown> {
  /** socket.io event name pushed to clients. */
  event: string;
  /** pg NOTIFY channel this device publishes on. */
  notifyChannel: string;
  /** NOTIFY payload row (snake_case) -> typed reading. */
  map: (row: Record<string, unknown>) => R;
  /** Last known reading of each device, sent to a new client right away. */
  latestPerDevice: () => Promise<R[]>;
}

/** DI token for the assembled list of live device descriptors. */
export const LIVE_DEVICES = Symbol('LIVE_DEVICES');
