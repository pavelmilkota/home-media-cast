import { describe, expect, it } from 'vitest';
import { BrowseQuerySchema } from './catalog.js';

describe('BrowseQuerySchema', () => {
  it.each([
    [{ type: 'movie', list: 'popular' }, true],
    [{ type: 'series', list: 'featured', genre: 'Reality-TV', skip: '50' }, true],
    [{ type: 'movie', list: 'new', genre: '1999' }, true],
    [{ type: 'movie', list: 'new', genre: 'Action' }, false],
    [{ type: 'movie', list: 'popular', genre: 'Reality-TV' }, false],
    [{ type: 'movie', list: 'popular', skip: '-1' }, false],
    [{ type: 'movie', list: 'popular', other: 1 }, false],
  ])('%j -> %j', (query, ok) => {
    expect(BrowseQuerySchema.safeParse(query).success).toBe(ok);
  });
});
