import { Component } from '@angular/core';

/**
 * "System" section: placeholder for future server monitoring, status and logs.
 */
@Component({
  selector: 'app-system-section',
  standalone: true,
  template: `
    <section class="system-placeholder">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 5h16v10H4V5zm0 12h16v2H4v-2zM6 7v6h12V7H6zm2 2h8v2H8V9z" />
      </svg>
      <h2>System</h2>
      <p>Hier erscheinen künftig Monitoring-Daten vom Server, Systemstatus und relevante Logs.</p>
    </section>
  `,
  styleUrl: './system-section.component.scss',
})
export class SystemSectionComponent {}
