import { Controller, Get, Head, Param, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator.js';
import { RelayService } from './relay.service.js';

/**
 * Public on purpose: Kodi cannot send a bearer token. The protection is that the service answers
 * only connections from this machine, and that the id is a random capability with a time limit.
 * Left out of the OpenAPI document because it is not an API for clients.
 */
@Public()
@ApiExcludeController()
@Controller('relay')
export class RelayController {
  constructor(private readonly relay: RelayService) {}

  // `:name` is only there so Kodi shows a title; it is never read.
  @Get([':id', ':id/:name'])
  get(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    return this.relay.handle(req, res, id);
  }

  @Head([':id', ':id/:name'])
  head(@Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    return this.relay.handle(req, res, id);
  }
}
