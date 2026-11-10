import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildLike, SpawnFn, SpawnOptions } from '../ffmpeg.js';

/** A process that does nothing but record what it was given and write HLS files on demand. */
export class FakeProcess extends EventEmitter implements ChildLike {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  exited = false;
  segments = 0;
  /** What `writeSegments` writes as `init.mp4`. */
  init: Buffer | string = 'init';

  constructor(
    readonly file: 'ffmpeg' | 'ffprobe',
    readonly args: readonly string[],
    readonly options: SpawnOptions,
  ) {
    super();
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (signal === 'SIGKILL' || signal === 'SIGTERM') this.exit(null, signal);
    return true;
  }

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }

  /** Writes segments until `count` exist, and the playlist that lists them. */
  writeSegments(count: number): void {
    const dir = this.options.cwd as string;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'init.mp4'), this.init);
    for (let n = this.segments; n < count; n++) writeFileSync(join(dir, `seg${n}.m4s`), `seg${n}`);
    this.segments = Math.max(this.segments, count);
    const list = Array.from(
      { length: this.segments },
      (_, n) => `#EXTINF:4.000000,\nseg${n}.m4s\n`,
    );
    writeFileSync(
      join(dir, 'index.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-PLAYLIST-TYPE:EVENT',
        '#EXT-X-MAP:URI="init.mp4"',
        ...list,
      ].join('\n'),
    );
  }
}

export const probeJson = (overrides: Record<string, unknown> = {}) => ({
  format: { duration: '7200.5' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', height: 1080, pix_fmt: 'yuv420p' },
    {
      codec_type: 'audio',
      codec_name: 'eac3',
      channels: 6,
      tags: { language: 'ukr', title: 'Dub' },
    },
    { codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'eng' } },
    { codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } },
  ],
  ...overrides,
});

export interface FakeSpawn {
  spawn: SpawnFn;
  processes: FakeProcess[];
  ffmpeg(): FakeProcess[];
  /** What `ffprobe` will answer. */
  probe: { json: unknown; fail: boolean };
  /** Segments an `ffmpeg` writes the moment it starts (0 = none yet). */
  initialSegments: number;
  /** What an `ffmpeg` writes as `init.mp4` (not a real init segment by default). */
  init: Buffer | string;
  /** An `ffmpeg` that exits with this code at once, writing nothing. */
  failFfmpegWith: number | undefined;
  /** An `ffmpeg` given this input (a dead relay link) exits with 1 at once, writing nothing. */
  failFfmpegReading: string | undefined;
}

export function createFakeSpawn(): FakeSpawn {
  const processes: FakeProcess[] = [];
  const fake: FakeSpawn = {
    processes,
    probe: { json: probeJson(), fail: false },
    initialSegments: 1,
    init: 'init',
    failFfmpegWith: undefined,
    failFfmpegReading: undefined,
    ffmpeg: () => processes.filter((p) => p.file === 'ffmpeg'),
    spawn: (file, args, options) => {
      const proc = new FakeProcess(file, args, options);
      proc.init = fake.init;
      processes.push(proc);
      queueMicrotask(() => {
        if (file === 'ffprobe') {
          if (fake.probe.fail) {
            proc.stderr.write('Invalid data found when processing input\n');
            return void setImmediate(() => proc.exit(1));
          }
          proc.stdout.write(JSON.stringify(fake.probe.json));
          return void setImmediate(() => proc.exit(0));
        }
        const dead = fake.failFfmpegReading;
        const failWith =
          fake.failFfmpegWith ?? (dead !== undefined && args.includes(dead) ? 1 : undefined);
        if (failWith !== undefined) {
          proc.stderr.write('http://127.0.0.1:1/api/relay/RELAYID: Server returned 502\n');
          return void setImmediate(() => proc.exit(failWith));
        }
        if (fake.initialSegments > 0) proc.writeSegments(fake.initialSegments);
      });
      return proc;
    },
  };
  return fake;
}
