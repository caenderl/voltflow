import { Component, input } from '@angular/core';

/** One detail line: a name, its value, and optionally when it happened. */
export interface StatRow {
  label: string;
  value: string;
  /** Shown behind the value, muted — e.g. the date a record was set. */
  hint?: string;
}

/**
 * The secondary figures under a headline: label left, value right. Sits inside
 * an {@link StatCardComponent} (or any card), separated by a rule.
 */
@Component({
  selector: 'app-stat-rows',
  standalone: true,
  template: `
    <dl class="stat-rows">
      @for (row of rows(); track row.label) {
        <div>
          <dt>{{ row.label }}</dt>
          <dd>
            {{ row.value }}
            @if (row.hint) {
              <span class="hint">{{ row.hint }}</span>
            }
          </dd>
        </div>
      }
    </dl>
  `,
  styleUrl: './stat-rows.component.scss',
})
export class StatRowsComponent {
  readonly rows = input.required<StatRow[]>();
}
