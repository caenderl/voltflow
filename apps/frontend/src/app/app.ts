import { Component } from '@angular/core';
import { Dashboard } from './dashboard';

@Component({
  imports: [Dashboard],
  selector: 'app-root',
  template: '<app-dashboard />',
})
export class App {}
