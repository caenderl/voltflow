import { Component, input, model } from '@angular/core';
import { FormsModule } from '@angular/forms';

/**
 * Labelled text (or date) input. Reusable form control: two-way bind the value
 * with `[value]`/`(valueChange)` (a `model()` output). Styling is shared with
 * NumberFieldComponent via ../field.scss.
 */
@Component({
  selector: 'app-text-field',
  standalone: true,
  imports: [FormsModule],
  template: `
    <label class="field">
      <span>{{ label() }}</span>
      <input
        [type]="type()"
        [ngModel]="value()"
        (ngModelChange)="value.set($event)"
        [placeholder]="placeholder()"
      />
    </label>
  `,
  styleUrl: '../field.scss',
})
export class TextFieldComponent {
  readonly label = input.required<string>();
  readonly type = input<'text' | 'date'>('text');
  readonly placeholder = input('');
  readonly value = model('');
}
