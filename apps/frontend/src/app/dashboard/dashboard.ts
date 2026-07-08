import { Component, OnInit, inject, signal } from '@angular/core';
import { APP_VERSION } from '../../version';
import { type View } from '../core/date-utils';
import {
  ConfigModalComponent,
  type CheckpointSaveEvent,
  type ConfigSaveEvent,
} from './config-modal/config-modal.component';
import { DashboardDataService } from './dashboard-data.service';
import { HistoryContainerComponent } from './history-container/history-container.component';
import { LiveContainerComponent } from './live-container/live-container.component';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [ConfigModalComponent, LiveContainerComponent, HistoryContainerComponent],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class Dashboard implements OnInit {
  private readonly data = inject(DashboardDataService);

  readonly appVersion = APP_VERSION;

  // View state (everything data-related lives in DashboardDataService)
  readonly view = signal<View>('live');
  readonly configOpen = signal(false);

  // Data signals needed by the config modal
  readonly tariff = this.data.tariff;
  readonly checkpoints = this.data.checkpoints;
  readonly wallboxConfig = this.data.wallboxConfig;
  readonly smaConfig = this.data.smaConfig;

  readonly views: { id: View; label: string }[] = [
    { id: 'live', label: 'Live' },
    { id: 'day', label: 'Tag' },
    { id: 'week', label: 'Woche' },
    { id: 'month', label: 'Monat' },
  ];

  ngOnInit(): void {
    this.data.start();
  }

  openConfig(): void {
    this.configOpen.set(true);
  }

  closeConfig(): void {
    this.configOpen.set(false);
  }

  onConfigSave(event: ConfigSaveEvent): void {
    // Close the modal only when every save succeeded; errors stay visible.
    void this.data.saveConfig(event).then((ok) => {
      if (ok) this.configOpen.set(false);
    });
  }

  onCheckpointSave(event: CheckpointSaveEvent): void {
    this.data.saveCheckpoint(event);
  }

  onCheckpointDelete(id: number): void {
    this.data.deleteCheckpoint(id);
  }

  select(view: View): void {
    this.view.set(view);
  }
}
