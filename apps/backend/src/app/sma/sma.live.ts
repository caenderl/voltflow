import { SMA_READING_EVENT, type SmaReading } from '@org/shared-types';
import type { HasLatestPerDevice } from '../common/device-capabilities';
import type { LiveDeviceDescriptor } from '../live/live-device';
import { rowToSmaReading } from './sma.mapper';

/** Live channel descriptor for the SMA inverters. */
export function smaLiveDescriptor(
  sma: HasLatestPerDevice<SmaReading>,
): LiveDeviceDescriptor<SmaReading> {
  return {
    event: SMA_READING_EVENT,
    notifyChannel: 'sma_reading',
    map: rowToSmaReading,
    latestPerDevice: () => sma.latestPerDevice(),
  };
}
