import { Component, input } from '@angular/core';

/**
 * A live device reading: icon + name, a status pill, a big value with unit,
 * a sub-line, and room for extra rows (project as content). Shared by
 * wallbox-card and sma-card, which differed only in class-name prefix.
 */
@Component({
  selector: 'app-live-reading-card',
  standalone: true,
  template: `
    <section class="live-reading-card">
      <div class="lrc-head">
        <span class="lrc-title"><ng-content select="[icon]" />{{ name() }}</span>
        <span class="lrc-status" [class.active]="active() && !stale()" [class.stale]="stale()">
          {{ statusLabel() }}
        </span>
      </div>
      <div class="lrc-power">{{ value() }}<span>{{ unit() }}</span></div>
      <div class="lrc-sub">{{ sub() }}</div>
      <ng-content />
    </section>
  `,
  styleUrl: './live-reading-card.component.scss',
})
export class LiveReadingCardComponent {
  readonly name = input.required<string>();
  readonly statusLabel = input.required<string>();
  /** Highlights the status pill (e.g. "charging" / "producing"). */
  readonly active = input(false);
  /** No fresh reading in a while - takes precedence over `active` styling. */
  readonly stale = input(false);
  readonly value = input.required<string>();
  readonly unit = input('');
  readonly sub = input('');
}
