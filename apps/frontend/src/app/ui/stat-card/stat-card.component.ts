import { Component, computed, input } from '@angular/core';

/** Which semantic the headline figure carries (colours the value and the dot). */
export type StatAccent = 'solar' | 'import' | 'primary';

// Mirrors core/stat-format's EM_DASH. Not imported from there: this component
// is a presentational primitive under ui/ and stays free of any dependency on
// app-specific formatting, same as its siblings (number-field, text-field, …).
const EM_DASH = '–';

/**
 * A headline figure with its unit, a caption underneath and room for detail
 * rows (project an `app-stat-rows`, or anything else, as content).
 *
 * `value` is a formatted string, not a number: the card has no opinion on
 * decimals or units, the caller formats with the helpers in core/stat-format.
 */
@Component({
  selector: 'app-stat-card',
  standalone: true,
  template: `
    <section class="stat-card" [attr.data-accent]="accent()">
      <span class="label">{{ label() }}</span>
      <span class="value"
        >{{ value() }}@if (showUnit()) {<small>{{ unit() }}</small>}</span
      >
      @if (caption()) {
        <span class="caption">{{ caption() }}</span>
      }
      <ng-content />
    </section>
  `,
  styleUrl: './stat-card.component.scss',
})
export class StatCardComponent {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly unit = input<string>('');
  readonly caption = input<string>('');
  readonly accent = input<StatAccent>('primary');

  /** A missing figure carries no unit — "– kWh" reads as a measurement. */
  readonly showUnit = computed(() => !!this.unit() && this.value() !== EM_DASH);
}
