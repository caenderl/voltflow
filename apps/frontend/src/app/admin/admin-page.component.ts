import { Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AdminSection } from '../core/config-types';
import { CheckpointsSectionComponent } from './checkpoints-section/checkpoints-section.component';
import { ConfigSectionComponent } from './config-section/config-section.component';
import { SystemSectionComponent } from './system-section/system-section.component';

/**
 * Admin shell: back link + top navigation, rendering one of the three sections
 * (Konfiguration / Zählerstände / System). Each section owns its own state.
 */
@Component({
  selector: 'app-admin-page',
  standalone: true,
  imports: [RouterLink, ConfigSectionComponent, CheckpointsSectionComponent, SystemSectionComponent],
  templateUrl: './admin-page.component.html',
  styleUrl: './admin-page.component.scss',
})
export class AdminPageComponent {
  readonly activeTab = signal<AdminSection>('config');
}
