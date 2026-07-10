import { Component, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';

/**
 * Labelled numeric input. Value is `number | null` (clearing the field yields
 * null) so callers can fall back to a default on save. Two-way bind via
 * `[value]`/`(valueChange)`. Styling shared with TextFieldComponent.
 */
@Component({
  selector: 'app-number-field',
  standalone: true,
  imports: [FormsModule],
  template: `
    <label class="field">
      <span>{{ label() }}</span>
      <input
        type="number"
        [min]="min()"
        [max]="max()"
        [step]="step()"
        [ngModel]="value()"
        (ngModelChange)="value.set($event)"
        [placeholder]="placeholder()"
      />
    </label>
  `,
  styleUrl: '../field.scss',
})
export class NumberFieldComponent {
  readonly label = input.required<string>();
  readonly placeholder = input('');
  readonly min = input<number | null>(null);
  readonly max = input<number | null>(null);
  readonly step = input<number | string | null>(null);
  readonly value = model<number | null>(null);
}
