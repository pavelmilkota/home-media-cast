import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayService } from '../relay/relay.service.js';
import type { ClassifiedResult } from '../sources/stream-source.js';
import type { StreamsService } from '../sources/streams.service.js';
import type { BrowserProgressSink } from './browser-session.service.js';
import { ExternalSessionService, fileNameFor } from './external-session.service.js';
import { createFakeSpawn } from './testing/fake-ffmpeg.js';

const SIZE = 10_000_000_000;
const DURATION_MS = 7_200_500;
const classified = {
  source: { kind: 'direct_url', url: 'https://provider.example/f.mkv?token=SECRET', headers: {} },
  title: 'Movie 2023 [1080p].mkv',
  cached: true,
} as unknown as ClassifiedResult;

/** Enough of a response for the service: it counts the socket's bytes and may be destroyed. */
function fakeResponse() {
  const res = Object.assign(new EventEmitter(), {
    socket: { bytesWritten: 0 },
    headersSent: false,
    destroyed: false,
    setHeader: () => undefined,
    writeHead: () => res,
    end: () => undefined,
    destroy() {
      res.destroyed = true;
      res.emit('close');
    },
  });
  return res;
}
const request = (range?: string) =>
  ({ method: 'GET', headers: range ? { range } : {} }) as unknown as IncomingMessage;

describe('ExternalSessionService', () => {
  let clock: number;
  let saves: [number, number][];
  let started: string[];
  let service: ExternalSessionService;

  const streams = {
    linkFor: async () => ({ id: 'relay1', url: 'http://127.0.0.1:8787/api/relay/relay1' }),
  } as unknown as StreamsService;
  const relay = {
    sizeOf: () => SIZE,
    forget: () => undefined,
    serve: async () => 'served' as const,
  } as unknown as RelayService;

  beforeEach(() => {
    clock = 1_000_000;
    saves = [];
    started = [];
    const progress: BrowserProgressSink = {
      prepare: async () => ({
        item: { title: { id: 'tt1', type: 'movie', name: 'M' }, videoId: 'tt1' },
        commit: () => undefined,
      }),
      save: (_item, positionMs, durationMs) => void saves.push([positionMs, durationMs]),
    };
    service = new ExternalSessionService(streams, relay, {
      spawn: createFakeSpawn().spawn,
      progress,
      now: () => clock,
      marginMs: 10_000,
    });
    service.onStarted = async (id) => void started.push(id);
  });

  const begin = async () => {
    const info = await service.start('dev1', { classified, title: { type: 'movie', id: 'tt1' } });
    return { info, id: info.path.split('/')[2]! };
  };
  const play = async (id: string, range?: string) => {
    const res = fakeResponse();
    await service.serve(id, request(range), res as unknown as ServerResponse);
    return res;
  };

  it('names the file after the release, harmlessly', () => {
    expect(fileNameFor('Movie 2023 [1080p].mkv')).toBe('Movie_2023_1080p_.mkv');
    expect(fileNameFor('../../etc/passwd')).not.toContain('/');
    expect(fileNameFor('')).toBe('video');
    expect(fileNameFor('x'.repeat(300))).toHaveLength(80);
  });

  it('starts nothing until the first sequential read', async () => {
    const { id } = await begin();
    expect(service.active()).toBeUndefined();
    await play(id, `bytes=${SIZE - 1000}-`); // the index at the end of the file
    expect(started).toEqual([]);
    expect(service.active()).toBeUndefined();
    await play(id);
    expect(started).toEqual([id]);
    expect(service.active()).toMatchObject({
      kind: 'external',
      approximate: true,
      deviceId: 'dev1',
    });
  });

  it('estimates the position from the bytes sent, minus the margin', async () => {
    const { id } = await begin();
    const res = await play(id);
    clock += 20_000;
    res.socket.bytesWritten = SIZE / 100; // 1% of the file: 72 s of 2 h
    service.tick();
    expect(service.active()?.positionMs).toBe(Math.round(DURATION_MS / 100) - 10_000);
  });

  it('saves to the library only after 30 seconds of sequential reading', async () => {
    const { id } = await begin();
    const res = await play(id);
    res.socket.bytesWritten = SIZE / 50;
    clock += 10_000;
    service.tick();
    clock += 10_000;
    service.tick();
    expect(saves).toEqual([]); // 20 s: too early
    clock += 11_000;
    res.socket.bytesWritten = SIZE / 25;
    service.tick();
    expect(saves).toHaveLength(1);
    expect(saves[0]?.[1]).toBe(DURATION_MS);
    expect(saves[0]?.[0]).toBeGreaterThan(270_000);
  });

  it('does not save the position of a read that was cut short by a seek back to the start', async () => {
    const { id } = await begin();
    const first = await play(id);
    clock += 5000;
    first.destroy();
    const second = await play(id, `bytes=${SIZE / 2}-`);
    clock += 5000;
    second.socket.bytesWritten = 1000;
    service.tick();
    expect(saves).toEqual([]); // sequential reading starts over after a seek
    expect(service.active()?.positionMs).toBeGreaterThan(3_000_000);
  });

  it('does not end while a response is open, however long one connection lasts', async () => {
    const { id } = await begin();
    const res = await play(id);
    for (let i = 0; i < 4; i++) {
      clock += 60 * 60_000; // an hour on one connection: a long film read in one go
      service.tick();
    }
    expect(service.activeCount).toBe(1);
    expect(res.destroyed).toBe(false);
  });

  it('ends after 30 minutes without a request once nothing is open', async () => {
    const { id } = await begin();
    const res = await play(id);
    res.emit('close');
    clock += 29 * 60_000;
    service.tick();
    expect(service.activeCount).toBe(1);
    clock += 2 * 60_000;
    service.tick();
    await Promise.resolve();
    expect(service.activeCount).toBe(0);
  });

  it('ends after 12 hours however busy it is', async () => {
    const { id } = await begin();
    for (let h = 0; h < 12; h++) {
      clock += 3_600_000;
      await play(id);
      service.tick();
    }
    clock += 1000;
    await play(id);
    service.tick();
    await Promise.resolve();
    expect(service.activeCount).toBe(0);
  });

  it('a device has one external session at a time; another device waits for the first read', async () => {
    const first = await begin();
    await play(first.id);
    const mine = await begin();
    expect(service.activeCount).toBe(1); // the first one was replaced
    const other = await service.start('dev2', { classified, title: undefined });
    expect(service.activeCount).toBe(2);
    expect(mine.id).not.toBe(other.path.split('/')[2]);
  });

  it('survives a missing ffprobe: the player gets the file, there is no estimate', async () => {
    const noProbe = new ExternalSessionService(streams, relay, {
      spawn: () => {
        throw new Error('spawn ffprobe ENOENT');
      },
      now: () => clock,
    });
    const info = await noProbe.start('dev1', { classified, title: undefined });
    expect(info.durationMs).toBe(0);
    const id = info.path.split('/')[2]!;
    const res = fakeResponse();
    await noProbe.serve(id, request(), res as unknown as ServerResponse);
    expect(noProbe.active()?.positionMs).toBe(0);
  });

  it('refuses a method other than GET and HEAD', async () => {
    const { id } = await begin();
    const res = fakeResponse();
    const writeHead = vi.fn(() => res);
    res.writeHead = writeHead;
    await service.serve(
      id,
      { method: 'POST', headers: {} } as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    );
    expect(writeHead).toHaveBeenCalledWith(404, expect.anything());
  });
});
