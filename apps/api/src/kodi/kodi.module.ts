import { Global, Module } from '@nestjs/common';
import { KodiService } from './kodi.service.js';

@Global()
@Module({
  providers: [{ provide: KodiService, useFactory: () => new KodiService() }],
  exports: [KodiService],
})
export class KodiModule {}
