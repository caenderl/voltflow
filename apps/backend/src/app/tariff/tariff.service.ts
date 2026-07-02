import { Injectable } from '@nestjs/common';
import type { Tariff } from '@org/shared-types';
import { numOrNull } from '../common/db-utils';
import { SingletonConfigStore, asStringOrNull } from '../common/singleton-config';
import { DbService } from '../database/db.service';

const EMPTY: Tariff = { provider: null, importCtPerKwh: null, exportCtPerKwh: null };

@Injectable()
export class TariffService {
  private readonly config: SingletonConfigStore<Tariff>;

  constructor(db: DbService) {
    this.config = new SingletonConfigStore<Tariff>(
      db,
      'tariff',
      [
        { column: 'provider', key: 'provider', fromDb: asStringOrNull },
        { column: 'import_ct_kwh', key: 'importCtPerKwh', fromDb: numOrNull },
        { column: 'export_ct_kwh', key: 'exportCtPerKwh', fromDb: numOrNull },
      ],
      EMPTY,
    );
  }

  get(): Promise<Tariff> {
    return this.config.get();
  }

  save(t: Tariff): Promise<Tariff> {
    return this.config.save(t);
  }
}
