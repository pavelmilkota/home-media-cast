import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import {
  KodiInvalidUrlError,
  KodiNoActivePlayerError,
  KodiRpcError,
  KodiTimeoutError,
  KodiUnavailableError,
} from './kodi/kodi.errors.js';
import {
  SourceAuthError,
  SourceNotConfiguredError,
  SourceUnavailableError,
} from './aiostreams/aiostreams.client.js';
import { MetadataUnavailableError, TitleNotFoundError } from './catalog/cinemeta.client.js';
import { UrlRejectedError } from './playback/url-guard.js';
import { RestartRateLimitedError, RestartUnavailableError } from './tv/kodi-restart.service.js';
import { QueueFullError } from './sources/queue.service.js';
import { NoMatchingSourceError, NoAdjacentEpisodeError } from './sources/watch-play.service.js';
import { OptionExpiredError, StreamLinkError } from './sources/streams.service.js';

interface Mapped {
  status: number;
  error: string;
  message: string;
}

function map(e: unknown): Mapped | undefined {
  if (e instanceof UrlRejectedError || e instanceof KodiInvalidUrlError) {
    return { status: 422, error: 'url_rejected', message: e.message };
  }
  if (e instanceof OptionExpiredError) {
    return { status: 410, error: 'option_expired', message: e.message };
  }
  if (e instanceof StreamLinkError) {
    return {
      status: 502,
      error: e.reason === 'expired' ? 'stream_expired' : 'stream_unreachable',
      message: `${e.message}. Try another source.`,
    };
  }
  if (e instanceof SourceNotConfiguredError) {
    return {
      status: 503,
      error: 'source_not_configured',
      message: 'No stream source is configured',
    };
  }
  if (e instanceof SourceUnavailableError || e instanceof SourceAuthError) {
    // The auth case is the owner's to fix in .env; the phone only needs "not available".
    return {
      status: 503,
      error: 'source_unavailable',
      message: 'The stream source is not available right now',
    };
  }
  if (e instanceof NoAdjacentEpisodeError) {
    return { status: 404, error: 'no_adjacent_episode', message: e.message };
  }
  if (e instanceof NoMatchingSourceError) {
    return {
      status: 404,
      error: 'no_matching_source',
      message: `${e.message}. Pick a source by hand.`,
    };
  }
  if (e instanceof QueueFullError) {
    return { status: 409, error: 'queue_full', message: e.message };
  }
  if (e instanceof TitleNotFoundError) {
    return { status: 404, error: 'title_not_found', message: e.message };
  }
  if (e instanceof MetadataUnavailableError) {
    return {
      status: 503,
      error: 'metadata_unavailable',
      message: 'The title catalog is not available right now',
    };
  }
  if (e instanceof RestartRateLimitedError) {
    return { status: 429, error: 'restart_rate_limited', message: e.message };
  }
  if (e instanceof RestartUnavailableError) {
    return { status: 503, error: 'restart_unavailable', message: e.message };
  }
  if (e instanceof KodiNoActivePlayerError) {
    return { status: 409, error: 'nothing_playing', message: 'Nothing is playing' };
  }
  if (e instanceof KodiUnavailableError || e instanceof KodiTimeoutError) {
    return { status: 503, error: 'kodi_unavailable', message: 'Kodi is not responding' };
  }
  if (e instanceof KodiRpcError) {
    return { status: 502, error: 'kodi_error', message: 'Kodi rejected the command' };
  }
  return undefined;
}

/** Turns backend-domain errors into clear HTTP errors. Nest handles everything else. */
@Catch(
  UrlRejectedError,
  KodiInvalidUrlError,
  KodiNoActivePlayerError,
  KodiUnavailableError,
  KodiTimeoutError,
  KodiRpcError,
  OptionExpiredError,
  StreamLinkError,
  SourceNotConfiguredError,
  SourceUnavailableError,
  SourceAuthError,
  MetadataUnavailableError,
  TitleNotFoundError,
  NoAdjacentEpisodeError,
  NoMatchingSourceError,
  QueueFullError,
  RestartRateLimitedError,
  RestartUnavailableError,
)
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const { status, error, message } = map(exception)!;
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json({ statusCode: status, error, message });
  }
}
