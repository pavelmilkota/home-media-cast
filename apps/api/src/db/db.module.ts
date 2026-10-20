import { Global, Module } from '@nestjs/common';
import { loadConfig } from '../config.js';
import { DbService } from './db.service.js';

@Global()
@Module({
  providers: [{ provide: DbService, useFactory: () => new DbService(loadConfig().dbPath) }],
  exports: [DbService],
})
export class DbModule {}
