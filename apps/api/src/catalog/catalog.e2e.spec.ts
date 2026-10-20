import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  BrowseResponse,
  LibraryResponse,
  SearchResponse,
  TitleDetail,
  TitleState,
} from '@home-media-cast/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, pairDevice, type TestApp } from '../testing/test-app.js';

const hit = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  imdb_id: id,
  name,
  releaseInfo: '2008',
  poster: `https://img.example/${id}.jpg`,
  ...extra,
});

const PAST = '2008-01-21T05:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

const SERIES = {
  meta: {
    id: 'tt0903747',
    name: 'Breaking Bad',
    releaseInfo: '2008–2013',
    poster: 'https://img.example/tt0903747.jpg',
    description: 'A teacher turns to crime.',
    imdbRating: '9.5',
    genres: ['Crime', 'Drama'],
    cast: ['Bryan Cranston'],
    videos: [
      { id: 'tt0903747:1:2', season: 1, number: 2, name: 'Cat', firstAired: PAST },
      { id: 'tt0903747:0:1', season: 0, number: 1, name: 'Special', firstAired: PAST },
      {
        id: 'tt0903747:1:1',
        season: 1,
        number: 1,
        name: 'Pilot',
        firstAired: PAST,
        thumbnail: 'https://img.example/pilot.jpg',
      },
      { id: 'tt0903747:1:3', season: 1, number: 3, name: 'Future', firstAired: FUTURE },
    ],
  },
};

describe('catalog and library (e2e)', () => {
  let t: TestApp;
  let token: string;
  let cinemeta: Server;
  let requests: string[];
  let down: boolean;
  let saved: string | undefined;

  beforeEach(async () => {
    requests = [];
    down = false;
    cinemeta = createServer((req, res) => {
      requests.push(req.url ?? '');
      const send = (code: number, body: unknown) =>
        void res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (down) return send(500, {});
      const url = decodeURIComponent(req.url ?? '');
      if (url.startsWith('/catalog/movie/top/search=')) {
        return send(200, {
          metas: [
            hit('tt0133093', 'The Matrix', { type: 'movie' }),
            { id: 'bad id', name: 'Hostile' },
            hit('tt0234215', 'Matrix Reloaded', { poster: 'javascript:alert(1)' }),
          ],
        });
      }
      if (url.startsWith('/catalog/series/top/search=')) {
        return send(200, { metas: [hit('tt0903747', 'Matrix Show')] });
      }
      if (url.startsWith('/catalog/movie/year/genre=')) {
        return send(200, { metas: [hit('tt0000001', url)] });
      }
      if (url === '/catalog/series/imdbRating/genre=Drama&skip=50.json') {
        return send(200, { metas: [hit('tt0000002', 'Featured drama')] });
      }
      if (url === '/catalog/movie/top.json') {
        return send(200, {
          metas: [hit('tt0133093', 'The Matrix'), hit('tt0111161', 'Shawshank')],
        });
      }
      if (url === '/catalog/series/top.json') {
        return send(200, { metas: [hit('tt0903747', 'Matrix Show'), hit('tt0944947', 'Thrones')] });
      }
      if (url === '/meta/series/tt0903747.json') return send(200, SERIES);
      if (url === '/meta/movie/tt0133093.json') {
        return send(200, {
          meta: {
            id: 'tt0133093',
            name: 'The Matrix',
            releaseInfo: '1999',
            trailers: [
              { source: 'not a video id', type: 'Trailer' },
              { source: 'vKQi3bBA1y8', type: 'Trailer' },
            ],
          },
        });
      }
      send(200, { meta: {} });
    });
    await new Promise<void>((r) => cinemeta.listen(0, '127.0.0.1', r));
    saved = process.env['CINEMETA_URL'];
    process.env['CINEMETA_URL'] = `http://127.0.0.1:${(cinemeta.address() as AddressInfo).port}`;
    t = await createTestApp();
    token = await pairDevice(t);
  });
  afterEach(async () => {
    await t.close();
    if (saved === undefined) delete process.env['CINEMETA_URL'];
    else process.env['CINEMETA_URL'] = saved;
    cinemeta.closeAllConnections();
    await new Promise((r) => cinemeta.close(r));
  });

  const get = (path: string) => t.http('GET', path, { token });
  const put = (path: string, body: unknown) => t.http('PUT', path, { token, body });

  it('needs a token', async () => {
    for (const [m, p] of [
      ['GET', '/catalog/search?q=matrix'],
      ['GET', '/catalog/discover'],
      ['GET', '/catalog/browse?type=movie&list=popular'],
      ['GET', '/catalog/movie/tt0133093'],
      ['PUT', '/catalog/movie/tt0133093/state'],
      ['PUT', '/catalog/movie/watched/tt0133093'],
      ['GET', '/library'],
    ] as const) {
      expect((await t.http(m, p)).status, `${m} ${p}`).toBe(401);
    }
    expect(requests).toEqual([]);
  });

  it('searches movies and series together, drops hostile entries and non-https posters', async () => {
    const res = await get('/catalog/search?q=matrix');
    expect(res.status).toBe(200);
    const { results } = res.body as SearchResponse;
    expect(results.map((r) => [r.id, r.type])).toEqual([
      ['tt0133093', 'movie'],
      ['tt0903747', 'series'],
      ['tt0234215', 'movie'],
    ]);
    expect(results[2]).not.toHaveProperty('poster');
    expect(JSON.stringify(res.body)).not.toContain('javascript');
  });

  it('suggests popular titles, interleaved and without what the household already has', async () => {
    await put('/catalog/movie/tt0133093/state', { saved: true });
    const res = await get('/catalog/discover');
    expect(res.status).toBe(200);
    expect((res.body as SearchResponse).results.map((r) => r.id)).toEqual([
      'tt0903747',
      'tt0111161',
      'tt0944947',
    ]);
  });

  it('browses popular, new and featured lists page by page', async () => {
    const popular = await get('/catalog/browse?type=movie&list=popular');
    expect(popular.status).toBe(200);
    expect(popular.body).toMatchObject({ nextSkip: 2 });
    expect((popular.body as BrowseResponse).results.map((r) => r.id)).toEqual([
      'tt0133093',
      'tt0111161',
    ]);

    const year = String(new Date().getFullYear());
    const fresh = await get('/catalog/browse?type=movie&list=new');
    expect((fresh.body as BrowseResponse).results[0]?.name).toBe(
      `/catalog/movie/year/genre=${year}.json`,
    );
    const old = await get('/catalog/browse?type=movie&list=new&genre=1999&skip=50');
    expect((old.body as BrowseResponse).results[0]?.name).toBe(
      '/catalog/movie/year/genre=1999&skip=50.json',
    );

    const featured = await get('/catalog/browse?type=series&list=featured&genre=Drama&skip=50');
    expect((featured.body as BrowseResponse).results.map((r) => r.id)).toEqual(['tt0000002']);
  });

  it('ends a list on an empty page and refuses unknown genres, lists and types', async () => {
    const end = await get('/catalog/browse?type=movie&list=featured&genre=Drama');
    expect(end.status).toBe(200);
    expect(end.body).toEqual({ results: [] });
    for (const q of [
      'type=movie&list=popular&genre=Nope',
      'type=movie&list=new&genre=Action',
      'type=movie&list=popular&genre=Reality-TV',
      'type=movie&list=trending',
      'type=book&list=popular',
      'type=movie&list=popular&skip=-1',
      'type=movie&list=popular&extra=1',
      'list=popular',
    ]) {
      expect((await get(`/catalog/browse?${q}`)).status, q).toBe(400);
    }
  });

  it('shows a provider outage on browse as "not available"', async () => {
    down = true;
    expect((await get('/catalog/browse?type=movie&list=popular')).status).toBe(503);
  });

  it('rejects a search that is too short', async () => {
    expect((await get('/catalog/search?q=a')).status).toBe(400);
    expect((await get('/catalog/search')).status).toBe(400);
  });

  it('shows one metadata outage as "not available", and a partial one as partial results', async () => {
    down = true;
    const res = await get('/catalog/search?q=matrix');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'metadata_unavailable' });
  });

  it('shows a title page with ordered episodes and nothing watched', async () => {
    const res = await get('/catalog/series/tt0903747');
    expect(res.status).toBe(200);
    const d = res.body as TitleDetail;
    expect(d).toMatchObject({
      id: 'tt0903747',
      name: 'Breaking Bad',
      rating: '9.5',
      state: { liked: false, saved: false },
      nextUp: 'tt0903747:1:1',
    });
    expect(d.episodes.map((e) => e.id)).toEqual([
      'tt0903747:0:1',
      'tt0903747:1:1',
      'tt0903747:1:2',
      'tt0903747:1:3',
    ]);
    expect(d.episodes.find((e) => e.id === 'tt0903747:1:3')?.released).toBe(false);
  });

  it('answers 404 for an unknown title and 400 for a malformed id', async () => {
    expect((await get('/catalog/movie/tt9999999')).status).toBe(404);
    expect((await get('/catalog/movie/not-an-id')).status).toBe(400);
    expect((await get('/catalog/tv/tt0133093')).status).toBe(400);
  });

  it('likes and saves a title, and lists it in the library', async () => {
    const liked = await put('/catalog/movie/tt0133093/state', { liked: true });
    expect(liked.body).toEqual({ liked: true, saved: false } satisfies TitleState);
    await put('/catalog/series/tt0903747/state', { saved: true });
    await put('/catalog/movie/tt0133093/state', { saved: true });
    await put('/catalog/movie/tt0133093/state', { liked: false });

    const lib = (await get('/library')).body as LibraryResponse;
    expect(lib.favorites).toEqual([]);
    expect(lib.saved.map((s) => s.id).sort()).toEqual(['tt0133093', 'tt0903747']);
    expect(((await get('/catalog/movie/tt0133093')).body as TitleDetail).state).toEqual({
      liked: false,
      saved: true,
    });
  });

  it('refuses unknown fields in a state change', async () => {
    expect((await put('/catalog/movie/tt0133093/state', { liked: 'yes' })).status).toBe(400);
    expect((await put('/catalog/movie/tt0133093/state', { admin: true })).status).toBe(400);
  });

  it('marks episodes watched, moves "next up" on, and can undo it', async () => {
    const mark = (id: string, watched: boolean) =>
      t.http('PUT', `/catalog/series/watched/${id}`, { token, body: { watched } });
    expect((await mark('tt0903747:1:1', true)).status).toBe(204);

    let d = (await get('/catalog/series/tt0903747')).body as TitleDetail;
    expect(d.episodes.find((e) => e.id === 'tt0903747:1:1')?.watched).toBe(true);
    expect(d.nextUp).toBe('tt0903747:1:2');

    const lib = (await get('/library')).body as LibraryResponse;
    expect(lib.history[0]).toMatchObject({
      id: 'tt0903747',
      videoId: 'tt0903747:1:1',
      label: 'S1E1 · Pilot',
      watched: true,
    });
    expect(lib.continueWatching).toEqual([]);

    await mark('tt0903747:1:1', false);
    d = (await get('/catalog/series/tt0903747')).body as TitleDetail;
    expect(d.nextUp).toBe('tt0903747:1:1');
    expect(((await get('/library')).body as LibraryResponse).history).toEqual([]);
  });

  it('marks the aired episodes of a season watched and passes thumbnails on', async () => {
    const season = (n: string, watched: boolean) =>
      t.http('PUT', `/catalog/series/tt0903747/seasons/${n}/watched`, { token, body: { watched } });
    expect((await season('1', true)).status).toBe(204);
    let d = (await get('/catalog/series/tt0903747')).body as TitleDetail;
    const of = (id: string) => d.episodes.find((e) => e.id === id);
    expect(of('tt0903747:1:1')).toMatchObject({
      watched: true,
      thumbnail: 'https://img.example/pilot.jpg',
    });
    expect(of('tt0903747:1:2')?.watched).toBe(true);
    expect(of('tt0903747:1:3')?.watched).toBe(false);
    expect(of('tt0903747:0:1')?.watched).toBe(false);

    await season('1', false);
    d = (await get('/catalog/series/tt0903747')).body as TitleDetail;
    expect(d.episodes.some((e) => e.watched)).toBe(false);
    expect((await season('abc', true)).status).toBe(400);
  });

  it('marks a movie watched and refuses an id that does not match the type', async () => {
    const r = await t.http('PUT', '/catalog/movie/watched/tt0133093', {
      token,
      body: { watched: true },
    });
    expect(r.status).toBe(204);
    expect(((await get('/catalog/movie/tt0133093')).body as TitleDetail).watched).toBe(true);
    const bad = await t.http('PUT', '/catalog/movie/watched/tt0903747:1:1', {
      token,
      body: { watched: true },
    });
    expect(bad.status).toBe(400);
  });

  describe('trailer', () => {
    const opens = () => t.kodi.requests.filter((r) => r.method === 'Player.Open');
    const play = (path: string, withToken = true) =>
      t.http('POST', path, withToken ? { token } : {});

    it('offers the first valid YouTube id and none when Cinemeta lists no trailer', async () => {
      expect(((await get('/catalog/movie/tt0133093')).body as TitleDetail).trailer).toBe(
        'vKQi3bBA1y8',
      );
      expect(
        ((await get('/catalog/series/tt0903747')).body as TitleDetail).trailer,
      ).toBeUndefined();
    });

    it('plays it through the YouTube addon, with the id taken from the metadata', async () => {
      const res = await play('/catalog/movie/tt0133093/trailer');
      expect(res.status).toBe(202);
      expect(opens()).toHaveLength(1);
      expect(JSON.stringify(opens()[0])).toContain(
        'plugin://plugin.video.youtube/play/?video_id=vKQi3bBA1y8',
      );
    });

    it('answers 404 and sends nothing to Kodi when there is no trailer', async () => {
      expect((await play('/catalog/series/tt0903747/trailer')).status).toBe(404);
      expect(opens()).toHaveLength(0);
    });

    it('needs a token and a valid title id', async () => {
      expect((await play('/catalog/movie/tt0133093/trailer', false)).status).toBe(401);
      expect((await play('/catalog/movie/bad/trailer')).status).toBe(400);
      expect(opens()).toHaveLength(0);
    });
  });
});
