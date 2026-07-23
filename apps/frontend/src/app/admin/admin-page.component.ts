import { Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { AdminSection } from '../core/config-types';
import { CheckpointsSectionComponent } from './checkpoints-section/checkpoints-section.component';
import { ConfigSectionComponent } from './config-section/config-section.component';
import { SystemSectionComponent } from './system-section/system-section.component';
import { TariffsSectionComponent } from './tariffs-section/tariffs-section.component';

/**
 * Admin shell: back link + top navigation, rendering one of the sections
 * (Konfiguration / Tarife / Zählerstände / System). Each section owns its state.
 */
@Component({
  selector: 'app-admin-page',
  standalone: true,
  imports: [
    RouterLink,
    ConfigSectionComponent,
    TariffsSectionComponent,
    CheckpointsSectionComponent,
    SystemSectionComponent,
  ],
  templateUrl: './admin-page.component.html',
  styleUrl: './admin-page.component.scss',
})
export class AdminPageComponent {
  readonly activeTab = signal<AdminSection>('config');
}
