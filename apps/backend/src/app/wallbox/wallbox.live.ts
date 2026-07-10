import { WALLBOX_READING_EVENT, type WallboxReading } from '@org/shared-types';
import type { HasLatest } from '../common/device-capabilities';
import type { LiveDeviceDescriptor } from '../live/live-device';
import { rowToWallboxReading } from './wallbox.mapper';

/** Live channel descriptor for the wallbox. */
export function wallboxLiveDescriptor(
  wallbox: HasLatest<WallboxReading>,
): LiveDeviceDescriptor<WallboxReading> {
  return {
    event: WALLBOX_READING_EVENT,
    notifyChannel: 'wallbox_reading',
    map: rowToWallboxReading,
    latest: () => wallbox.latest(),
  };
}
