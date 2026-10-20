import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  YoutubeCastSchema,
  type YoutubeCastDto,
  type YoutubeCastStatus,
} from '@home-media-cast/shared';
import { YoutubeService } from './youtube.service.js';

/** Needs a device token like every other route: the switch is not for the YouTube app. */
@Controller('youtube')
export class YoutubeController {
  constructor(private readonly youtube: YoutubeService) {}

  @Get('cast')
  status(): YoutubeCastStatus {
    return this.youtube.status();
  }

  @Put('cast')
  set(@Body({ schema: YoutubeCastSchema }) dto: YoutubeCastDto): Promise<YoutubeCastStatus> {
    return this.youtube.setEnabled(dto.enabled);
  }
}
