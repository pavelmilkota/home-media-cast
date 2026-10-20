import { Global, Module } from '@nestjs/common';
import { loadConfig } from '../config.js';
import { UrlGuard } from '../playback/url-guard.js';
import { RelayController } from './relay.controller.js';
import { RelayService } from './relay.service.js';

@Global()
@Module({
  controllers: [RelayController],
  providers: [
    {
      provide: RelayService,
      useFactory: () => {
        const config = loadConfig();
        // A self-hosted AIOStreams may be on a private network; its stream URLs must reach the relay.
        const aioHost = config.aiostreams ? [new URL(config.aiostreams.url).hostname] : [];
        const guard = new UrlGuard({ allowHosts: [...config.playbackAllowHosts, ...aioHost] });
        return new RelayService({
          check: (url) => guard.check(url),
          baseUrl: `http://127.0.0.1:${config.port}`,
        });
      },
    },
  ],
  exports: [RelayService],
})
export class RelayModule {}
