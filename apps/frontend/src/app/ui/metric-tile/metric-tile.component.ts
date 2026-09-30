import { Component, input } from '@angular/core';

/**
 * One admin-panel metric: a label + coloured headline value, a sub-line, and
 * room for a chart/bar/list (project as content). Shared by system-metrics
 * (CPU/memory/disk) and system-backups (local/off-site), which differed only
 * in class-name prefix.
 */
@Component({
  selector: 'app-metric-tile',
  standalone: true,
  template: `
    <article class="metric-tile">
      <div class="mt-head">
        <span class="mt-label">{{ label() }}</span>
        <span class="mt-value" [style.color]="color()">{{ value() }}</span>
      </div>
      @if (sub()) {
        <p class="mt-sub">{{ sub() }}</p>
      }
      <ng-content />
    </article>
  `,
  styleUrl: './metric-tile.component.scss',
})
export class MetricTileComponent {
  readonly label = input.required<string>();
  readonly value = input.required<string>();
  readonly color = input<string | null>(null);
  readonly sub = input<string>('');
}
