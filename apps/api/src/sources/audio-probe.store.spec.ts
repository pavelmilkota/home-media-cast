import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { DbService } from '../db/db.service.js';
import { AudioProbeStore } from './audio-probe.store.js';

describe('AudioProbeStore: video facts', () => {
  it('keeps the video facts next to the tracks', () => {
    const store = new AudioProbeStore(new DbService(':memory:'));
    store.put('k', [{ language: 'English' }], 1000, { codec: 'hevc', height: 1080, hdr: 'none' });
    expect(store.getFacts(['k'], 2000).get('k')).toEqual({
      tracks: [{ language: 'English' }],
      video: { codec: 'hevc', height: 1080, hdr: 'none' },
    });
    expect(store.getMany(['k'], 2000).get('k')).toEqual([{ language: 'English' }]);
  });

  it('answers a row written before video facts existed, with no video', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hmc-probe-')), 'app.db');
    new DbService(path).onModuleDestroy();
    const raw = new Database(path);
    raw
      .prepare('INSERT INTO audio_probe (key, tracks, probed_at) VALUES (?, ?, ?)')
      .run('old', JSON.stringify([{ codec: 'AAC' }]), 1000);
    raw.close();
    const db = new DbService(path);
    expect(new AudioProbeStore(db).getFacts(['old'], 2000).get('old')).toEqual({
      tracks: [{ codec: 'AAC' }],
    });
    db.onModuleDestroy();
  });
});
