import { Controller, Get, Head, Param, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator.js';
import { BrowserSessionService } from './browser-session.service.js';
import { ExternalSessionService } from './external-session.service.js';

/**
 * Public on purpose: `<video>` and native HLS cannot send `Authorization`, and ADR-0007 keeps the
 * device token out of URLs. The protection is the session id: random, bound to one session, gone
 * when the session ends, and checked against the allowlist of file names. Left out of the OpenAPI
 * document, like the relay.
 */
@Public()
@ApiExcludeController()
@Controller('media')
export class MediaController {
  constructor(
    private readonly sessions: BrowserSessionService,
    private readonly external: ExternalSessionService,
  ) {}

  /**
   * The source's own bytes for an external player, with `Range`. `:name` is only there so the
   * player shows something; the session id decides. Declared before the HLS routes, which would
   * read `file` as a run number and refuse it.
   */
  @Get(':id/file/:name')
  file(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    return this.external.serve(id, req, res);
  }

  @Head(':id/file/:name')
  fileHead(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    return this.external.serve(id, req, res);
  }

  @Get(':id/:run/:file')
  get(
    @Param('id') id: string,
    @Param('run') run: string,
    @Param('file') file: string,
    @Res() res: Response,
  ): Promise<void> {
    return this.serve(id, run, file, res);
  }

  @Head(':id/:run/:file')
  head(
    @Param('id') id: string,
    @Param('run') run: string,
    @Param('file') file: string,
    @Res() res: Response,
  ): Promise<void> {
    return this.serve(id, run, file, res);
  }

  private async serve(id: string, run: string, file: string, res: Response): Promise<void> {
    const found = /^\d{1,6}$/.test(run)
      ? await this.sessions.mediaFile(id, Number(run), file)
      : undefined;
    if (!found) {
      res.status(404).set('Cache-Control', 'no-store').end();
      return;
    }
    res.set('Cache-Control', 'no-store');
    if (found.kind === 'playlist') {
      res.status(200).type('application/vnd.apple.mpegurl').send(found.body);
      return;
    }
    res.type(found.contentType);
    // `sendFile` answers Range requests, which Safari uses for the init segment and segments.
    res.sendFile(
      found.name,
      { root: found.root, dotfiles: 'deny', etag: false, lastModified: false, cacheControl: false },
      (err) => {
        // A segment can be deleted under a slow player: that is a 404, not a server error.
        if (err && !res.headersSent) res.status(404).end();
      },
    );
  }
}
