import { Component } from '@angular/core';
import { CONFIGURABLE_DRIVERS } from '@org/shared-types';
import { DeviceInstanceListComponent } from './device-instance-list/device-instance-list.component';

/**
 * "Geräte" section: one instance list per configurable driver. Thin wrapper —
 * each list owns its form state and pulls its own rows from the registry.
 *
 * Iterates {@link CONFIGURABLE_DRIVERS} rather than naming the drivers, so a
 * new driver shows up here by having traits, not by being added to a template.
 */
@Component({
  selector: 'app-devices-section',
  standalone: true,
  imports: [DeviceInstanceListComponent],
  templateUrl: './devices-section.component.html',
  styleUrl: './devices-section.component.scss',
})
export class DevicesSectionComponent {
  readonly drivers = CONFIGURABLE_DRIVERS;
}
