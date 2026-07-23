import { Body, Controller, Get, Put } from '@nestjs/common';
import type { AppSettings } from '@org/shared-types';
import { AppSettingsService } from './app-settings.service';

@Controller('app-settings')
export class AppSettingsController {
  constructor(private readonly settings: AppSettingsService) {}

  @Get()
  get(): Promise<AppSettings> {
    return this.settings.get();
  }

  @Put()
  save(@Body() body: Partial<AppSettings>): Promise<AppSettings> {
    // One boolean flag: coerce anything truthy to true, everything else to false.
    return this.settings.save({ calibrationEnabled: Boolean(body.calibrationEnabled) });
  }
}
