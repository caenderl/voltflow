import { METER_READING_EVENT, type MeterReading } from '@org/shared-types';
import type { HasLatestPerDevice } from '../common/device-capabilities';
import type { LiveDeviceDescriptor } from '../live/live-device';
import { rowToReading } from './meter.mapper';

/** Live channel descriptor for the smart meters. */
export function meterLiveDescriptor(
  meter: HasLatestPerDevice<MeterReading>,
): LiveDeviceDescriptor<MeterReading> {
  return {
    event: METER_READING_EVENT,
    notifyChannel: 'meter_reading',
    map: rowToReading,
    latestPerDevice: () => meter.latestPerDevice(),
  };
}
