import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import type { SystemHealth } from '@org/shared-types';
import { SettingsCardComponent } from '../../ui/settings-card/settings-card.component';
import { SystemApiService } from '../../core/system-api.service';
import { SystemContainersComponent } from './system-containers.component';
import { SystemMetricsComponent } from './system-metrics.component';

/** How long the rolling window keeps samples (charts span this). */
const WINDOW_MS = 10 * 60 * 1000;
/** Poll cadence — 10 min window / 10 s ≈ 60 points. */
const POLL_MS = 10_000;

/**
 * "System" section: polls host health and keeps a 10-minute rolling window in
 * memory (nothing is persisted). Renders live metric charts + the container
 * list. Polling starts on mount and stops when the tab is left (this component
 * is created/destroyed by the admin @switch).
 */
@Component({
  selector: 'app-system-section',
  standalone: true,
  imports: [SettingsCardComponent, SystemMetricsComponent, SystemContainersComponent],
  templateUrl: './system-section.component.html',
  styleUrl: './system-section.component.scss',
})
export class SystemSectionComponent {
  private readonly api = inject(SystemApiService);

  readonly history = signal<SystemHealth[]>([]);
  readonly error = signal(false);
  /** No successful sample yet (initial loading state). */
  readonly pending = computed(() => this.history().length === 0);

  private readonly latest = computed(() => this.history().at(-1) ?? null);
  readonly containers = computed(() => this.latest()?.containers ?? []);
  readonly uptime = computed(() => formatUptime(this.latest()?.uptimeSec ?? null));

  constructor() {
    this.load();
    const id = setInterval(() => this.load(), POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(id));
  }

  private load(): void {
    this.api.health().subscribe({
      next: (h) => {
        this.error.set(false);
        const cutoff = Date.now() - WINDOW_MS;
        this.history.update((prev) =>
          [...prev, h].filter((s) => new Date(s.time).getTime() >= cutoff),
        );
      },
      error: () => this.error.set(true),
    });
  }
}

/** "3 d 4 h" / "5 h 12 min" / "8 min" from a seconds count. */
function formatUptime(sec: number | null): string {
  if (sec == null) return '';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  return `${m} min`;
}
