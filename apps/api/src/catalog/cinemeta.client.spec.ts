import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CinemetaClient, MetadataUnavailableError } from './cinemeta.client.js';

/** Answers recorded from the real v3-cinemeta.strem.io on 2026-10-20, trimmed to a few items. */
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const clientFor = (answer: (path: string) => Response) => {
  const paths: string[] = [];
  const client = new CinemetaClient({
    baseUrl: 'http://cinemeta.test',
    ttlMs: 0,
    fetchFn: async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return answer(path);
    },
  });
  return { client, paths };
};

describe('CinemetaClient against recorded real answers', () => {
  it('reads a search page', async () => {
    const { client } = clientFor(() => json(fixture('search-inception.json')));
    const hits = await client.search('movie', 'inception');
    expect(hits[0]).toMatchObject({
      id: 'tt1375666',
      type: 'movie',
      name: 'Inception',
      year: '2010',
    });
    expect(hits[0]?.poster).toMatch(/^https:\/\//);
  });

  it('reads a browse page', async () => {
    const { client } = clientFor(() => json(fixture('catalog-top.json')));
    const hits = await client.browse('movie', 'top');
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => /^tt\d+$/.test(h.id) && h.name && h.poster)).toBe(true);
  });

  it('reads a movie with its trailer and no episodes', async () => {
    const { client } = clientFor(() => json(fixture('meta-movie.json')));
    const m = await client.meta('movie', 'tt1375666');
    expect(m).toMatchObject({
      name: 'Inception',
      year: '2010',
      rating: '8.8',
      trailer: 'cdx31ak4KbQ',
    });
    expect(m.videos).toEqual([]);
    expect(m.genres.length).toBeGreaterThan(0);
  });

  it('reads a series with specials as season 0, sorted before season 1', async () => {
    const { client } = clientFor(() => json(fixture('meta-series.json')));
    const m = await client.meta('series', 'tt0903747');
    expect(m.trailer).toBe('VFkjBy2b50Q');
    expect(m.videos.map((v) => v.id)).toEqual([
      'tt0903747:0:1',
      'tt0903747:0:2',
      'tt0903747:1:1',
      'tt0903747:1:2',
      'tt0903747:1:3',
    ]);
    expect(m.videos[0]).toMatchObject({ season: 0, episode: 1, name: 'Good Cop Bad Cop' });
  });

  it('treats a series id asked as a movie (an empty meta) as not found', async () => {
    const { client } = clientFor(() => json({}));
    await expect(client.meta('series', 'tt1375666')).rejects.toThrow('Unknown title');
  });
});

describe('CinemetaClient gateway errors', () => {
  it('retries once after a cold-cache 504 and returns the second answer', async () => {
    let calls = 0;
    const { client, paths } = clientFor(() =>
      ++calls === 1 ? json({ status: 504 }, 504) : json(fixture('search-inception.json')),
    );
    expect(await client.search('movie', 'inception')).toHaveLength(3);
    expect(paths).toHaveLength(2);
  });

  it('gives up after one retry', async () => {
    const { client, paths } = clientFor(() => json({}, 504));
    await expect(client.search('movie', 'inception')).rejects.toBeInstanceOf(
      MetadataUnavailableError,
    );
    expect(paths).toHaveLength(2);
  });

  it('does not retry a plain 500 or a 404', async () => {
    const five = clientFor(() => json({}, 500));
    await expect(five.client.top('movie')).rejects.toBeInstanceOf(MetadataUnavailableError);
    expect(five.paths).toHaveLength(1);
    const four = clientFor(() => json({}, 404));
    await expect(four.client.meta('movie', 'tt1375666')).rejects.toThrow('Unknown title');
    expect(four.paths).toHaveLength(1);
  });
});
