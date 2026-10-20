import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import {
  AudioSchema,
  PairingCompleteSchema,
  PlaybackSchema,
  SeekSchema,
  SubtitleSchema,
  VolumeSchema,
} from '@home-media-cast/shared';
import { z } from 'zod';

/** Request bodies come from the same Zod schemas that validate them, so docs cannot drift. */
const BODIES: Record<string, z.ZodType> = {
  '/api/pairing/complete': PairingCompleteSchema,
  '/api/playback': PlaybackSchema,
  '/api/player/seek': SeekSchema,
  '/api/player/volume': VolumeSchema,
  '/api/player/audio': AudioSchema,
  '/api/player/subtitle': SubtitleSchema,
};
const PUBLIC_PATHS = ['/api/health', '/api/pairing/start', '/api/pairing/complete'];

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Home Media Cast')
      .setDescription(
        'Backend for the Kodi remote. Pair a device, then send the token as a bearer.',
      )
      .setVersion('0.0.0')
      .addBearerAuth()
      .build(),
  );
  document.security = [{ bearer: [] }];
  for (const [path, schema] of Object.entries(BODIES)) {
    const post = document.paths[path]?.post;
    if (post) {
      post.requestBody = {
        required: true,
        content: { 'application/json': { schema: z.toJSONSchema(schema) as never } },
      };
    }
  }
  for (const path of PUBLIC_PATHS) {
    for (const operation of Object.values(document.paths[path] ?? {})) {
      (operation as { security?: unknown[] }).security = [];
    }
  }
  return document;
}

export function setupOpenApi(app: INestApplication): void {
  SwaggerModule.setup('api/docs', app, buildOpenApiDocument(app), {
    jsonDocumentUrl: 'api/docs-json',
  });
}
