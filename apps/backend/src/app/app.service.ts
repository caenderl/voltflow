import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getVersion(): { version: string } {
    return { version: process.env['APP_VERSION'] ?? 'dev' };
  }
}
