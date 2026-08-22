import { Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { DRIVER_TRAITS, type DeviceDriver } from '@org/shared-types';
import {
  DeviceRegistryService,
  type DeviceInstance,
} from '../../../core/device-registry.service';
import { NumberFieldComponent } from '../../../ui/number-field/number-field.component';
import { SettingsCardComponent } from '../../../ui/settings-card/settings-card.component';
import { TextFieldComponent } from '../../../ui/text-field/text-field.component';
import { ToggleSwitchComponent } from '../../../ui/toggle-switch/toggle-switch.component';

/**
 * Add/edit form plus a table of configured instances for one driver - the
 * per-device-kind analog of the tariffs section's list+form (saves take
 * effect immediately, no shared footer). Instantiated once per driver by
 * `DevicesSectionComponent`; owns its own form state so the cards on the same
 * tab never share one in-progress edit.
 *
 * Everything driver-specific - the heading, the blurb, whether there are
 * Port/Unit-ID fields, what a new row starts with - comes from
 * `DRIVER_TRAITS`. The component itself knows no driver by name, which is what
 * makes a new device a traits entry rather than a new template.
 *
 * Deliberately does not read a shared error signal: several cards render at
 * once here (unlike every other admin section, which is alone on its tab), and
 * a shared signal would risk one card's failure surfacing under another. A
 * local, fixed message avoids that regardless of which card actually failed.
 */
@Component({
  selector: 'app-device-instance-list',
  standalone: true,
  imports: [SettingsCardComponent, ToggleSwitchComponent, TextFieldComponent, NumberFieldComponent],
  templateUrl: './device-instance-list.component.html',
  styleUrl: './device-instance-list.component.scss',
})
export class DeviceInstanceListComponent implements OnInit {
  private readonly registry = inject(DeviceRegistryService);

  /** Immutable for the lifetime of one instance — driver never changes on an edit. */
  readonly driver = input.required<DeviceDriver>();

  readonly traits = computed(() => DRIVER_TRAITS[this.driver()]);
  readonly instances = computed(() => this.registry.instancesOf(this.driver()));

  // Placeholders are strings, the defaults are numbers (and null where the
  // field does not apply) - converted here rather than in the template, where
  // `null + ''` would quietly render the word "null".
  readonly portPlaceholder = computed(() => String(this.traits().defaultPort ?? ''));
  readonly unitIdPlaceholder = computed(() => String(this.traits().defaultUnitId ?? ''));
  readonly intervalPlaceholder = computed(() =>
    String(this.traits().defaultPollIntervalS),
  );

  readonly formEditingId = signal<number | null>(null);
  readonly formName = signal('');
  readonly formEnabled = signal(false);
  readonly formHost = signal('');
  readonly formPort = signal<number | null>(null);
  readonly formUnitId = signal<number | null>(null);
  readonly formInterval = signal<number | null>(null);
  readonly formError = signal<string | null>(null);

  // Required signal inputs are not yet bound during construction (reading
  // them there throws NG0950) — seed the form once Angular has set them.
  ngOnInit(): void {
    this.resetForm();
  }

  resetForm(): void {
    const t = this.traits();
    this.formEditingId.set(null);
    this.formName.set('');
    this.formEnabled.set(false);
    this.formHost.set('');
    this.formPort.set(t.defaultPort);
    this.formUnitId.set(t.defaultUnitId);
    this.formInterval.set(t.defaultPollIntervalS);
    this.formError.set(null);
  }

  edit(i: DeviceInstance): void {
    const c = i.config;
    this.formEditingId.set(c.id);
    this.formName.set(c.name ?? '');
    this.formEnabled.set(c.enabled);
    this.formHost.set(c.host ?? '');
    this.formPort.set(c.port);
    this.formUnitId.set(c.unitId);
    this.formInterval.set(c.pollIntervalS);
    this.formError.set(null);
  }

  save(): void {
    this.formError.set(null);
    const t = this.traits();
    const editingId = this.formEditingId();
    void this.registry
      .save({
        id: editingId ?? undefined,
        driver: this.driver(),
        name: this.formName().trim() || null,
        enabled: this.formEnabled(),
        host: this.formHost().trim() || null,
        port: t.usesModbus ? (this.formPort() ?? t.defaultPort) : null,
        unitId: t.usesModbus ? (this.formUnitId() ?? t.defaultUnitId) : null,
        pollIntervalS: this.formInterval() ?? t.defaultPollIntervalS,
      })
      .then((ok) => {
        if (ok) this.resetForm();
        else {
          this.formError.set(
            editingId !== null
              ? 'Gerät konnte nicht gespeichert werden.'
              : 'Gerät konnte nicht angelegt werden.',
          );
        }
      });
  }

  remove(i: DeviceInstance): void {
    this.formError.set(null);
    if (this.formEditingId() === i.config.id) this.resetForm();
    void this.registry.remove(i.config.id).then((ok) => {
      if (!ok) this.formError.set('Gerät konnte nicht gelöscht werden.');
    });
  }
}
