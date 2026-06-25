import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getData(): { message: string } {
    return { message: 'Hello API' };
  }

  getVersion(): { version: string } {
    return { version: process.env['APP_VERSION'] ?? 'dev' };
  }
}
