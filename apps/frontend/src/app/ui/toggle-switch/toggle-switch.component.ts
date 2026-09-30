import { Component, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';

/**
 * On/off toggle switch with a state label. Two-way bind the state with
 * `[checked]`/`(checkedChange)` (a `model()` output).
 */
@Component({
  selector: 'app-toggle-switch',
  standalone: true,
  imports: [FormsModule],
  template: `
    <label class="switch">
      <input type="checkbox" [ngModel]="checked()" (ngModelChange)="checked.set($event)" />
      <span class="switch-track" aria-hidden="true"></span>
      <span class="switch-label">{{ checked() ? activeLabel() : inactiveLabel() }}</span>
    </label>
  `,
  styleUrl: './toggle-switch.component.scss',
})
export class ToggleSwitchComponent {
  readonly checked = model(false);
  readonly activeLabel = input('Aktiv');
  readonly inactiveLabel = input('Inaktiv');
}
