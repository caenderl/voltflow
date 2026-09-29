import { Component, input } from '@angular/core';
import type { ContainerStatus } from '@org/shared-types';

/** Read-only list of the stack's Docker containers with a state badge. */
@Component({
  selector: 'app-system-containers',
  standalone: true,
  templateUrl: './system-containers.component.html',
  styleUrl: './system-containers.component.scss',
})
export class SystemContainersComponent {
  readonly containers = input.required<ContainerStatus[]>();

  /** Badge modifier class from the Docker state string. */
  stateClass(state: string): string {
    switch (state) {
      case 'running':
        return 'ok';
      case 'restarting':
      case 'paused':
      case 'created':
        return 'warn';
      case 'exited':
      case 'dead':
        return 'err';
      default:
        return 'warn';
    }
  }
}
