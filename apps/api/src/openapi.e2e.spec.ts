import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './testing/test-app.js';

interface Doc {
  paths: Record<
    string,
    Record<
      string,
      { requestBody?: { content: Record<string, { schema: unknown }> }; security?: unknown[] }
    >
  >;
  security: unknown[];
}

describe('OpenAPI (e2e)', () => {
  let t: TestApp;
  let doc: Doc;
  beforeEach(async () => {
    t = await createTestApp();
    doc = (await (await fetch(`${t.base}/docs-json`)).json()) as Doc;
  });
  afterEach(async () => {
    await t.close();
  });

  it('serves the UI and the JSON document', async () => {
    const ui = await fetch(`${t.base}/docs`);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain('swagger');
  });

  it('lists every route', () => {
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        '/api/catalog/browse',
        '/api/catalog/discover',
        '/api/catalog/search',
        '/api/catalog/series/{id}/seasons/{season}/watched',
        '/api/catalog/{type}/watched/{videoId}',
        '/api/catalog/{type}/{id}',
        '/api/catalog/{type}/{id}/state',
        '/api/catalog/{type}/{id}/trailer',
        '/api/devices',
        '/api/devices/{id}',
        '/api/events',
        '/api/health',
        '/api/library',
        '/api/pairing/complete',
        '/api/pairing/start',
        '/api/queue',
        '/api/queue/next',
        '/api/queue/{id}',
        '/api/player/audio',
        '/api/player/pause',
        '/api/player/resume',
        '/api/player/seek',
        '/api/player/status',
        '/api/player/stop',
        '/api/player/subtitle',
        '/api/player/volume',
        '/api/streams/cache',
        '/api/streams/options/{id}/audio',
        '/api/titles/{type}/{id}/streams',
        '/api/tv/fullscreen',
        '/api/tv/home',
        '/api/tv/restart-kodi',
        '/api/tv/screensaver',
        '/api/playback',
        '/api/playback/episodes',
        '/api/playback/next',
        '/api/playback/previous',
        '/api/playback/stream',
        '/api/playback/youtube',
        '/api/youtube/cast',
      ].sort(),
    );
  });

  it('derives request bodies from the validation schemas', () => {
    const volume =
      doc.paths['/api/player/volume']!['post']!.requestBody!.content['application/json']!.schema;
    expect(volume).toMatchObject({
      properties: { volume: { type: 'integer', minimum: 0, maximum: 100 } },
    });
    const pairing =
      doc.paths['/api/pairing/complete']!['post']!.requestBody!.content['application/json']!.schema;
    expect(JSON.stringify(pairing)).toContain('^\\\\d{6}$');
    const cast =
      doc.paths['/api/youtube/cast']!['put']!.requestBody!.content['application/json']!.schema;
    expect(cast).toMatchObject({ properties: { enabled: { type: 'boolean' } } });
  });

  it('requires a bearer by default and marks the public routes', () => {
    expect(doc.security).toEqual([{ bearer: [] }]);
    expect(doc.paths['/api/health']!['get']!.security).toEqual([]);
    expect(doc.paths['/api/pairing/start']!['post']!.security).toEqual([]);
    expect(doc.paths['/api/player/stop']!['post']!.security).toBeUndefined();
  });
});
