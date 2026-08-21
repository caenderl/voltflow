import { Component, computed, inject } from '@angular/core';
import { DashboardDataService } from '../../dashboard/dashboard-data.service';
import { DeviceInstanceListComponent } from './device-instance-list/device-instance-list.component';

/**
 * "Geräte" section: one instance list per driver. Thin wrapper — each list
 * owns its own form state; this component only splits the flat
 * `deviceConfigs` signal by driver.
 */
@Component({
  selector: 'app-devices-section',
  standalone: true,
  imports: [DeviceInstanceListComponent],
  templateUrl: './devices-section.component.html',
  styleUrl: './devices-section.component.scss',
})
export class DevicesSectionComponent {
  private readonly data = inject(DashboardDataService);

  readonly smaDevices = computed(() =>
    this.data.deviceConfigs().filter((d) => d.driver === 'sma-speedwire'),
  );
  readonly wallboxDevices = computed(() =>
    this.data.deviceConfigs().filter((d) => d.driver === 'anker-v1-modbus'),
  );
}
