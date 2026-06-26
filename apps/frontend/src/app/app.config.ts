import {
  ApplicationConfig,
  LOCALE_ID,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeDe from '@angular/common/locales/de';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { provideEchartsCore } from 'ngx-echarts';
import { appRoutes } from './app.routes';

// German number formatting (comma as decimal separator) for all pipes.
registerLocaleData(localeDe);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(appRoutes),
    provideHttpClient(),
    provideEchartsCore({ echarts: () => import('echarts') }),
    { provide: LOCALE_ID, useValue: 'de-DE' },
  ],
};
