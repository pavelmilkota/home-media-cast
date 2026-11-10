import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  BrowserCapsSchema,
  HandoffHereSchema,
  HandoffTvSchema,
  type BrowserCapsDto,
  type BrowserSession,
  type HandoffHereDto,
  type HandoffTvDto,
} from '@home-media-cast/shared';
import type { AuthedRequest } from '../auth/auth.guard.js';
import { HandoffService } from './handoff.service.js';
import { GuestAllowed } from '../auth/guest-allowed.decorator.js';

/** Moves the one active session between the TV and browsers. */
@Controller('playback/handoff')
export class HandoffController {
  constructor(private readonly handoff: HandoffService) {}

  /**
   * Takes the active session (TV or another browser) to this device, at its position. The old
   * player stops only once this one reports it plays. 409 `handoff_pick_source` leaves it running.
   */
  @Post('here')
  here(
    @Req() req: AuthedRequest,
    @Body({ schema: HandoffHereSchema }) dto: HandoffHereDto,
  ): Promise<BrowserSession> {
    return this.handoff.here(req.device.id, dto.caps);
  }

  /** Starts a play from the history in this browser. 409 `handoff_pick_source` without a release key. */
  @GuestAllowed()
  @Post('replay/:id')
  replay(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body({ schema: BrowserCapsSchema }) dto: BrowserCapsDto,
  ): Promise<BrowserSession> {
    return this.handoff.replayHere(req.device.id, id, dto.caps, req.device.kind === 'guest');
  }

  /** Plays a browser session on the TV: this device's own if it plays, else the one playing. */
  @Post('tv')
  @HttpCode(204)
  tv(
    @Req() req: AuthedRequest,
    @Body({ schema: HandoffTvSchema }) dto: HandoffTvDto,
  ): Promise<void> {
    return this.handoff.toTv(req.device.id, dto.positionMs);
  }
}
