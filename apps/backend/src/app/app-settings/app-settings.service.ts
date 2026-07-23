import { Injectable } from '@nestjs/common';
import type { AppSettings } from '@org/shared-types';
import { SingletonConfigStore, asBool } from '../common/singleton-config';
import { DbService } from '../database/db.service';

const DEFAULTS: AppSettings = { calibrationEnabled: false };

@Injectable()
export class AppSettingsService {
  private readonly config: SingletonConfigStore<AppSettings>;

  constructor(db: DbService) {
    this.config = new SingletonConfigStore<AppSettings>(
      db,
      'app_settings',
      [{ column: 'calibration_enabled', key: 'calibrationEnabled', fromDb: asBool }],
      DEFAULTS,
    );
  }

  get(): Promise<AppSettings> {
    return this.config.get();
  }

  save(s: AppSettings): Promise<AppSettings> {
    return this.config.save(s);
  }
}
