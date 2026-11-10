import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotFoundException } from '@nestjs/common';
import type { DeviceCaps } from '@home-media-cast/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayService } from '../relay/relay.service.js';
import type { ClassifiedResult } from '../sources/stream-source.js';
import {
  OptionExpiredError,
  StreamLinkError,
  type StreamsService,
} from '../sources/streams.service.js';
import {
  BrowserSessionService,
  BrowserUnavailableError,
  BrowserUnsupportedError,
} from './browser-session.service.js';
import { createFakeSpawn, probeJson, type FakeSpawn } from './testing/fake-ffmpeg.js';

const CAPS: DeviceCaps = {
  h264: true,
  hevc: false,
  hevc10: false,
  vp9: true,
  av1: false,
  hdr: false,
};
const PROVIDER_URL = 'https://provider.example/file.mkv?token=PROVIDER-SECRET';

const source = (): ClassifiedResult => ({
  source: { kind: 'direct_url', url: PROVIDER_URL, headers: {} },
  title: 'Movie.2023.1080p.mkv',
  cached: true,
  infoHash: 'a'.repeat(40),
});

describe('BrowserSessionService', () => {
  let dir: string;
  let fake: FakeSpawn;
  let service: BrowserSessionService;
  let clock: number;
  let linkCount: number;
  let forgotten: string[];
  let expired: boolean;
  let linkFails: StreamLinkError | undefined;
  let linkImpl: (() => Promise<{ id: string; url: string }>) | undefined;
  let matchImpl: (...args: unknown[]) => Promise<string | undefined>;
  let resolveImpl: ((id: string) => ClassifiedResult) | undefined;
  let current: ClassifiedResult;

  const streams = {
    resolveOption: (id: string) => {
      if (resolveImpl) return resolveImpl(id);
      if (expired || id === 'gone') throw new OptionExpiredError('expired');
      return current;
    },
    linkFor: async () => {
      if (linkImpl) return linkImpl();
      if (linkFails) throw linkFails;
      return {
        id: `relay${++linkCount}`,
        url: `http://127.0.0.1:8787/api/relay/relay${linkCount}`,
      };
    },
    findMatching: (...args: unknown[]) => matchImpl(...args),
  } as unknown as StreamsService;
  const relay = { forget: (id: string) => forgotten.push(id) } as unknown as RelayService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmc-session-'));
    fake = createFakeSpawn();
    clock = 1_000_000;
    linkCount = 0;
    forgotten = [];
    expired = false;
    linkFails = undefined;
    linkImpl = undefined;
    resolveImpl = undefined;
    matchImpl = async () => undefined;
    current = source();
    service = new BrowserSessionService(streams, relay, {
      spawn: fake.spawn,
      mediaDir: dir,
      aheadSegments: 10,
      behindSegments: 5,
      idleMs: 60_000,
      endIdleMs: 600_000,
      pollMs: 5,
      startTimeoutMs: 500,
      now: () => clock,
      tickMs: 3_600_000, // ticks are driven by the tests
    });
    await service.onModuleInit();
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    rmSync(dir, { recursive: true, force: true });
  });

  const start = (over: Partial<Parameters<BrowserSessionService['start']>[1]> = {}) =>
    service.start('dev1', { optionId: 'opt', caps: CAPS, ...over });

  it('starts a copy session: probes through the relay, runs ffmpeg, returns the playlist path', async () => {
    const session = await start({ startMs: 90_000 });
    expect(session.mode).toBe('copy');
    expect(session.durationMs).toBe(7_200_500);
    expect(session.run).toEqual({
      n: 1,
      startMs: 90_000,
      playlistPath: `/media/${session.id}/1/index.m3u8`,
    });
    expect(session.audioTracks.map((a) => a.language)).toEqual(['ukr', 'eng']);
    expect(session.audioTracks[0]).not.toHaveProperty('codecName');
    const [probe, run] = fake.processes;
    expect(probe?.file).toBe('ffprobe');
    expect(run?.file).toBe('ffmpeg');
    expect(run?.args).toContain('-ss');
    // The provider link is behind the relay: neither process was given it.
    expect(JSON.stringify(fake.processes.map((p) => p.args))).not.toContain('provider.example');
    expect(JSON.stringify(session)).not.toContain('provider.example');
    expect(JSON.stringify(session)).not.toContain('relay1');
  });

  it('serves the init segment without edit lists, and the original when it cannot be read', async () => {
    // Firefox applies the empty edit ffmpeg writes with -copyts: a run that starts at 13 min would
    // sit 13 min after currentTime 0. (The start is read from the original: fmp4.spec.ts.)
    const box = (type: string, ...parts: Buffer[]) => {
      const body = Buffer.concat(parts);
      const head = Buffer.alloc(8);
      head.writeUInt32BE(8 + body.length);
      head.write(type, 4, 'latin1');
      return Buffer.concat([head, body]);
    };
    const u32 = (...v: number[]) => {
      const b = Buffer.alloc(4 * v.length);
      v.forEach((x, i) => b.writeUInt32BE(x >>> 0, i * 4));
      return b;
    };
    const trak = (edit: boolean) =>
      box(
        'trak',
        box('tkhd', u32(3, 0, 0, 1), Buffer.alloc(72)),
        ...(edit
          ? [box('edts', box('elst', u32(0, 2, 89_500, 0xffffffff, 0x10000, 1000, 0, 0x10000)))]
          : []),
        box('mdia', box('mdhd', u32(0, 0, 0, 1000, 0, 0))),
      );
    const init = (edit: boolean) =>
      Buffer.concat([
        box('ftyp', Buffer.from('iso5')),
        box('moov', box('mvhd', u32(0, 0, 0, 1000), Buffer.alloc(84)), trak(edit)),
      ]);
    fake.init = init(true);
    const session = await start({ startMs: 90_000 });
    const served = await service.mediaFile(session.id, 1, 'init.mp4');
    expect(served).toMatchObject({ kind: 'file', name: 'init-play.mp4' });
    const { root, name } = served as { root: string; name: string };
    expect(readFileSync(join(root, name))).toEqual(init(false));
    // The name itself is not one the player may ask for.
    expect(await service.mediaFile(session.id, 1, 'init-play.mp4')).toBeUndefined();

    fake.init = 'not an init segment';
    const other = await start();
    expect(await service.mediaFile(other.id, 1, 'init.mp4')).toMatchObject({ name: 'init.mp4' });
  });

  it('serves the playlist with EXT-X-START and refuses other runs and names', async () => {
    const { id } = await start();
    const playlist = await service.mediaFile(id, 1, 'index.m3u8');
    expect(playlist).toMatchObject({ kind: 'playlist' });
    expect((playlist as { body: string }).body).toMatch(/^#EXTM3U\n#EXT-X-START:TIME-OFFSET=0\n/);
    expect(await service.mediaFile(id, 1, 'seg0.m4s')).toMatchObject({
      kind: 'file',
      name: 'seg0.m4s',
    });
    expect(await service.mediaFile(id, 2, 'index.m3u8')).toBeUndefined();
    expect(await service.mediaFile('nope', 1, 'index.m3u8')).toBeUndefined();
    for (const bad of ['../index.m3u8', 'seg0.m4s.tmp', 'seg.m4s', 'a.mp4', 'index.m3u8/x', '']) {
      expect(await service.mediaFile(id, 1, bad)).toBeUndefined();
    }
  });

  it('refuses a video the device cannot decode, before any ffmpeg run', async () => {
    fake.probe.json = probeJson({
      streams: [{ codec_type: 'video', codec_name: 'av1', height: 1080 }],
    });
    await expect(start()).rejects.toBeInstanceOf(BrowserUnsupportedError);
    expect(fake.ffmpeg()).toHaveLength(0);
    expect(forgotten).toEqual(['relay1']);
    expect(service.activeCount).toBe(0);
  });

  it('refuses a file ffprobe cannot read, and a server without ffprobe', async () => {
    fake.probe.fail = true;
    await expect(start()).rejects.toBeInstanceOf(BrowserUnsupportedError);
    const missing = new BrowserSessionService(streams, relay, {
      spawn: () => {
        throw new Error('ENOENT');
      },
      mediaDir: dir,
      aheadSegments: 10,
      behindSegments: 5,
    });
    await expect(missing.start('dev1', { optionId: 'opt', caps: CAPS })).rejects.toBeInstanceOf(
      BrowserUnavailableError,
    );
  });

  it('a decode failure reported by the player converts from the next run, when converting is on', async () => {
    const { id } = await start();
    service.playerError(id, 'dev1', { kind: 'video.3', detail: 'x', positionMs: 0, decode: true });
    expect((await service.seek(id, 'dev1', 1000)).mode).toBe('copy'); // converting is off here
    const converting = new BrowserSessionService(streams, relay, {
      spawn: fake.spawn,
      mediaDir: dir,
      aheadSegments: 10,
      behindSegments: 5,
      pollMs: 5,
      transcode: { mode: 'software', hwDecode: false, device: '/dev/dri/renderD128' },
    });
    const other = await converting.start('dev2', { optionId: 'opt', caps: CAPS });
    expect(other.mode).toBe('copy');
    converting.playerError(other.id, 'dev2', {
      kind: 'hls.bufferAppendError',
      detail: '',
      positionMs: 5000,
      decode: false,
    });
    expect((await converting.seek(other.id, 'dev2', 5000)).mode).toBe('copy');
    converting.playerError(other.id, 'dev2', {
      kind: 'video.3',
      detail: '',
      positionMs: 5000,
      decode: true,
    });
    const after = await converting.seek(other.id, 'dev2', 5000);
    expect(after.mode).toBe('transcode');
    expect(fake.ffmpeg().at(-1)?.args).toContain('libx264');
    await converting.endAll();
  });

  it('reports a source ffmpeg cannot open as unreachable and leaves nothing behind', async () => {
    fake.failFfmpegWith = 1;
    await expect(start()).rejects.toBeInstanceOf(StreamLinkError);
    expect(service.activeCount).toBe(0);
    expect(existsSync(join(dir, fake.ffmpeg()[0]?.options.cwd?.split('/').at(-2) ?? 'x'))).toBe(
      false,
    );
  });

  it('a seek is a new run: the old one is killed and its files are gone', async () => {
    const first = await start();
    const firstDir = fake.ffmpeg()[0]?.options.cwd as string;
    const second = await service.seek(first.id, 'dev1', 1_800_000);
    expect(second.run).toMatchObject({ n: 2, startMs: 1_800_000 });
    expect(fake.ffmpeg()[0]?.signals).toContain('SIGKILL');
    expect(existsSync(firstDir)).toBe(false);
    expect(await service.mediaFile(first.id, 1, 'index.m3u8')).toBeUndefined();
    expect(await service.mediaFile(first.id, 2, 'index.m3u8')).toBeDefined();
    // The new run reads the same relay link: no new one from the provider.
    expect(forgotten).not.toContain('relay1');
    expect(fake.ffmpeg()[1]?.args).toContain('http://127.0.0.1:8787/api/relay/relay1');
    expect(linkCount).toBe(1);
  });

  it('asks for a fresh link when the new run cannot read the old one', async () => {
    const first = await start();
    fake.failFfmpegReading = 'http://127.0.0.1:8787/api/relay/relay1';
    const s = await service.seek(first.id, 'dev1', 60_000);
    expect(s.run.n).toBe(3); // the failed run on the old link, then one on the fresh link
    expect(forgotten).toContain('relay1');
    expect(fake.ffmpeg().at(-1)?.args).toContain('http://127.0.0.1:8787/api/relay/relay2');
  });

  it('clamps a seek past the end', async () => {
    const { id } = await start();
    const s = await service.seek(id, 'dev1', 99_999_999);
    expect(s.run.startMs).toBe(7_200_500 - 5000);
  });

  it('a seek after the option id expired still starts a run, with no new link', async () => {
    const { id } = await start();
    expired = true;
    const before = linkCount;
    const s = await service.seek(id, 'dev1', 60_000);
    expect(s.run.n).toBe(2);
    expect(linkCount).toBe(before);
  });

  it('a seek after the run stopped for idleness gets a fresh link', async () => {
    const { id } = await start();
    clock += 61_000;
    await service.tick();
    expect(forgotten).toContain('relay1');
    const s = await service.seek(id, 'dev1', 60_000);
    expect(s.run.n).toBe(2);
    expect(linkCount).toBe(2);
  });

  it('finds the same release again when the provider link is dead for good', async () => {
    const titled = await service.start('dev1', {
      optionId: 'opt',
      caps: CAPS,
      title: { type: 'movie', id: 'tt0111161' },
    });
    const replacement = { ...source(), title: 'Same.Release.mkv' };
    fake.failFfmpegReading = 'http://127.0.0.1:8787/api/relay/relay1'; // the old link is dead
    let calls = 0;
    linkImpl = async () => {
      if (++calls === 1) throw new StreamLinkError('expired', 'gone');
      return { id: `r${calls}`, url: 'http://127.0.0.1:8787/api/relay/x' };
    };
    const match = vi.fn(async () => 'new-option');
    matchImpl = match;
    resolveImpl = () => replacement;
    const s = await service.seek(titled.id, 'dev1', 1000);
    expect(s.run.n).toBe(3); // the failed run on the dead link, then the found release
    expect(match).toHaveBeenCalledWith(
      'movie',
      'tt0111161',
      expect.stringContaining('a'.repeat(40)),
    );
  });

  it('gives up when the link is dead and the release cannot be found', async () => {
    const titled = await service.start('dev1', {
      optionId: 'opt',
      caps: CAPS,
      title: { type: 'movie', id: 'tt0111161' },
    });
    linkFails = new StreamLinkError('expired', 'gone');
    fake.failFfmpegReading = 'http://127.0.0.1:8787/api/relay/relay1'; // the old link is dead
    // No match for the release either: the error reaches the caller.
    await expect(service.seek(titled.id, 'dev1', 1000)).rejects.toBeInstanceOf(StreamLinkError);
    // And without a title there is nothing to look the release up by.
    linkFails = undefined;
    const plain = await start();
    fake.failFfmpegReading = `http://127.0.0.1:8787/api/relay/relay${linkCount}`;
    linkFails = new StreamLinkError('expired', 'gone');
    await expect(service.seek(plain.id, 'dev1', 1000)).rejects.toBeInstanceOf(StreamLinkError);
  });

  it('only the owning device can seek or end; others get 404', async () => {
    const { id } = await start();
    await expect(service.seek(id, 'other', 0)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.endOwned(id, 'other')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.seek('unknown', 'dev1', 0)).rejects.toBeInstanceOf(NotFoundException);
    expect(service.activeCount).toBe(1);
  });

  it("a device's second session ends its first at once", async () => {
    const first = await start();
    const second = await service.start('dev1', { optionId: 'opt', caps: CAPS });
    expect(service.activeCount).toBe(1);
    expect(fake.ffmpeg()[0]?.signals).toContain('SIGKILL');
    expect(await service.mediaFile(first.id, 1, 'index.m3u8')).toBeUndefined();
    expect(await service.mediaFile(second.id, 1, 'index.m3u8')).toBeDefined();
  });

  it("another device's session keeps playing until the new one is confirmed", async () => {
    const first = await start();
    expect(service.confirm(first.id, 'dev1')).toBe(true);
    expect(service.active()).toMatchObject({ deviceId: 'dev1' });

    const second = await service.start('dev2', { optionId: 'opt', caps: CAPS });
    expect(service.activeCount).toBe(2);
    expect(await service.mediaFile(first.id, 1, 'index.m3u8')).toBeDefined();
    expect(service.active()?.id).toBe(first.id); // the new one is not the household's yet

    expect(service.confirm(second.id, 'dev2')).toBe(true);
    await service.endOthers(second.id);
    expect(service.activeCount).toBe(1);
    expect(await service.mediaFile(first.id, 1, 'index.m3u8')).toBeUndefined();
    expect(service.active()?.id).toBe(second.id);
  });

  it('confirm refuses an unknown session or another device', async () => {
    const { id } = await start();
    expect(service.confirm('nope', 'dev1')).toBe(false);
    expect(service.confirm(id, 'dev2')).toBe(false);
    expect(service.active()).toBeUndefined();
  });

  it('tells listeners when the playing session appears, moves on and ends', async () => {
    const seen: (number | undefined)[] = [];
    service.onChange(() => seen.push(service.active()?.positionMs));
    const { id } = await start();
    service.confirm(id, 'dev1');
    service.progress(id, 'dev1', 42_000);
    await service.endOwned(id, 'dev1');
    expect(seen).toEqual([0, 42_000, undefined]);
  });

  it('keeps the position of a seek for a handoff', async () => {
    const { id } = await start();
    service.confirm(id, 'dev1');
    await service.seek(id, 'dev1', 90_000);
    expect(service.active()?.positionMs).toBe(90_000);
  });

  it('end removes the files, kills ffmpeg and forgets the relay entry', async () => {
    const { id } = await start();
    const runDir = fake.ffmpeg()[0]?.options.cwd as string;
    await service.endOwned(id, 'dev1');
    expect(service.activeCount).toBe(0);
    expect(existsSync(runDir)).toBe(false);
    expect(existsSync(join(dir, id))).toBe(false);
    expect(fake.ffmpeg()[0]?.signals).toEqual(['SIGKILL']);
    expect(forgotten).toContain('relay1');
  });

  it("endForDevice ends only that device's session", async () => {
    await start();
    await service.endForDevice('someone-else');
    expect(service.activeCount).toBe(1);
    await service.endForDevice('dev1');
    expect(service.activeCount).toBe(0);
  });

  it('empties the media directory at startup', async () => {
    const stale = join(dir, 'old-session');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(stale, { recursive: true });
    await service.onModuleInit();
    expect(existsSync(stale)).toBe(false);
  });

  describe('pacing', () => {
    it('stops ffmpeg when it is far ahead, resumes when the player catches up, deletes behind', async () => {
      const { id } = await start();
      const proc = fake.ffmpeg()[0]!;
      proc.writeSegments(20); // 20 segments, the player fetched none: way ahead
      await service.tick();
      expect(proc.signals).toEqual(['SIGSTOP']);
      await service.tick();
      expect(proc.signals).toEqual(['SIGSTOP']); // not stopped twice

      // The player reaches segment 15: 4 ahead, within half the budget.
      await service.mediaFile(id, 1, 'seg15.m4s');
      await service.tick();
      expect(proc.signals).toEqual(['SIGSTOP', 'SIGCONT']);
      expect(existsSync(join(proc.options.cwd as string, 'seg9.m4s'))).toBe(false);
      expect(existsSync(join(proc.options.cwd as string, 'seg10.m4s'))).toBe(true);
      expect(existsSync(join(proc.options.cwd as string, 'init.mp4'))).toBe(true);
    });

    it('kills a run nobody fetches from, keeps the session, and a seek starts a new run', async () => {
      const { id } = await start();
      const proc = fake.ffmpeg()[0]!;
      clock += 61_000;
      await service.tick();
      expect(proc.signals).toContain('SIGKILL');
      expect(service.activeCount).toBe(1);
      expect(await service.mediaFile(id, 1, 'index.m3u8')).toBeUndefined();
      const s = await service.seek(id, 'dev1', 120_000);
      expect(s.run.n).toBe(2);
    });

    it('a stopped process is still killed when idle', async () => {
      await start();
      const proc = fake.ffmpeg()[0]!;
      proc.writeSegments(30);
      await service.tick();
      expect(proc.signals).toEqual(['SIGSTOP']);
      clock += 61_000;
      await service.tick();
      expect(proc.signals).toEqual(['SIGSTOP', 'SIGKILL']);
    });

    it('ends a session that nobody has touched for a long time', async () => {
      await start();
      clock += 601_000;
      await service.tick();
      expect(service.activeCount).toBe(0);
    });

    it('fetches and playlist reads keep the run alive', async () => {
      const { id } = await start();
      const proc = fake.ffmpeg()[0]!;
      for (let i = 0; i < 5; i++) {
        clock += 30_000;
        await service.mediaFile(id, 1, 'index.m3u8');
        await service.tick();
      }
      expect(proc.signals).not.toContain('SIGKILL');
    });
  });
});
