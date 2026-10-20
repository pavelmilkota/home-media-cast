import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonFileDataStore } from './json-file-data-store.js';

describe('JsonFileDataStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hmc-store-'));
    file = join(dir, 'nested', 'store.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null for a missing key', async () => {
    expect(await new JsonFileDataStore(file).get('nope')).toBeNull();
  });

  it('keeps values across instances, creating the folder', async () => {
    await new JsonFileDataStore(file).set('a', { x: 1 });
    expect(await new JsonFileDataStore(file).get('a')).toEqual({ x: 1 });
  });

  it('keeps false (the switch off) rather than treating it as missing', async () => {
    const store = new JsonFileDataStore(file);
    await store.set('enabled', false);
    expect(await new JsonFileDataStore(file).get('enabled')).toBe(false);
  });

  it('survives many concurrent writes with a valid file', async () => {
    const store = new JsonFileDataStore(file);
    await Promise.all(Array.from({ length: 50 }, (_, i) => store.set(`k${i}`, i)));
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>;
    expect(Object.keys(saved)).toHaveLength(50);
  });

  it('starts empty when the file is corrupt', async () => {
    new JsonFileDataStore(file); // creates the folder
    writeFileSync(file, '{not json');
    expect(await new JsonFileDataStore(file).get('a')).toBeNull();
  });

  it('writes the file readable by its owner only', async () => {
    await new JsonFileDataStore(file).set('a', 1);
    const { statSync } = await import('node:fs');
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('works in memory without a path', async () => {
    const store = new JsonFileDataStore();
    await store.set('a', 1);
    expect(await store.get('a')).toBe(1);
  });
});
