import {
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { Dashboard } from './dashboard/dashboard';

@Component({
  imports: [Dashboard],
  selector: 'app-root',
  template: `
    <app-dashboard />
    @if (updateReady()) {
    <div class="update-banner" role="status">
      <span>Neue Version verfügbar.</span>
      <button type="button" (click)="reload()">Neu laden</button>
    </div>
    }
  `,
  styles: [
    `
      .update-banner {
        position: fixed;
        inset: auto 0 0 0;
        margin: 0 auto 1rem;
        width: max-content;
        max-width: calc(100% - 2rem);
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 0.75rem 1rem;
        background: #212127;
        border: 1px solid #38343c;
        border-radius: 12px;
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
        color: #e5e1e6;
        font-size: 0.9rem;
        z-index: 1000;
      }
      .update-banner button {
        border: none;
        border-radius: 999px;
        padding: 0.4rem 0.9rem;
        background: #aac7ff;
        color: #06305c;
        font-weight: 600;
        cursor: pointer;
      }
      .update-banner button:hover {
        background: #d6e3ff;
      }
    `,
  ],
})
export class App {
  private readonly swUpdate = inject(SwUpdate);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly updateReady = signal(false);

  constructor() {
    if (!this.swUpdate.isEnabled) {
      return;
    }
    this.swUpdate.versionUpdates
      .pipe(
        filter(
          (e): e is VersionReadyEvent => e.type === 'VERSION_READY',
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.updateReady.set(true));
  }

  protected async reload(): Promise<void> {
    await this.swUpdate.activateUpdate();
    document.location.reload();
  }
}
