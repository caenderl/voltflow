import { Component, input } from '@angular/core';

/**
 * Card with a heading + optional subtitle and a body via content projection.
 * Project header-side controls (e.g. a toggle) into the `[card-actions]` slot.
 */
@Component({
  selector: 'app-settings-card',
  standalone: true,
  template: `
    <section class="settings-card">
      <div class="card-head">
        <div class="card-head-text">
          <h2>{{ heading() }}</h2>
          @if (subtitle()) {
            <p>{{ subtitle() }}</p>
          }
        </div>
        <ng-content select="[card-actions]" />
      </div>
      <ng-content />
    </section>
  `,
  styleUrl: './settings-card.component.scss',
})
export class SettingsCardComponent {
  readonly heading = input.required<string>();
  readonly subtitle = input<string>('');
}
