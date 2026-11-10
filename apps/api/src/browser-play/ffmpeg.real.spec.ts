import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStartMs } from './fmp4.js';
import { buildRunArgs, minimalEnv, nodeSpawn, probeMedia, type TranscodePlan } from './ffmpeg.js';

const installed = (bin: string) => spawnSync(bin, ['-version']).status === 0;
const available = installed('ffmpeg') && installed('ffprobe');

/**
 * Runs the real binaries on a clip made by `lavfi`, in the container (where `ffmpeg` is installed).
 * Skipped, with this name saying why, wherever `ffmpeg` is absent.
 */
describe.skipIf(!available)('real ffmpeg (skipped when ffmpeg or ffprobe is not installed)', () => {
  let work: string;
  let server: Server;
  let url: string;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'hmc-real-ffmpeg-'));
    const clip = join(work, 'clip.mkv');
    // One text subtitle track with a cue at 3 s and one at 8 s.
    const srt = join(work, 'subs.srt');
    writeFileSync(
      srt,
      '1\n00:00:03,000 --> 00:00:05,000\nHello early\n\n2\n00:00:08,000 --> 00:00:10,000\nHello late\n',
    );
    const subtitleInput = ['-map', '0:v', '-map', '1:a', '-map', '2:0'];
    // H.264 with a keyframe every second, and AC-3 audio: the audio has to be converted.
    const made = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=12:size=320x240:rate=25',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=12',
        '-i',
        srt,
        '-c:v',
        'libx264',
        '-g',
        '25',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'ac3',
        '-ac',
        '6',
        '-c:s',
        'srt',
        ...subtitleInput,
        clip,
      ],
      { encoding: 'utf8' },
    );
    if (made.status !== 0) throw new Error(`could not make the test clip: ${made.stderr}`);
    const bytes = readFileSync(clip);
    // A server that honours Range, like the relay does.
    server = createServer((req, res) => {
      const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (!m) {
        return void res
          .writeHead(200, { 'content-length': bytes.length, 'accept-ranges': 'bytes' })
          .end(bytes);
      }
      const from = Number(m[1]);
      const to = Math.min(m[2] ? Number(m[2]) : bytes.length - 1, bytes.length - 1);
      res
        .writeHead(206, {
          'content-range': `bytes ${from}-${to}/${bytes.length}`,
          'content-length': to - from + 1,
        })
        .end(bytes.subarray(from, to + 1));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/relay/test`;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise((r) => server?.close(r));
    rmSync(work, { recursive: true, force: true });
  });

  it('probes the clip', async () => {
    const media = await probeMedia(nodeSpawn, url);
    expect(media.durationMs).toBeGreaterThan(11_000);
    expect(media.video).toMatchObject({ codec: 'h264', height: 240, hdr: 'none' });
    expect(media.audio).toMatchObject([{ index: 0, codecName: 'ac3', channels: 6 }]);
  });

  const run = (
    startMs: number,
    name: string,
    subtitleStreams: number[] = [],
    transcode?: TranscodePlan,
    source: string = url,
  ) =>
    new Promise<{ dir: string; code: number | null; stderr: string }>((resolve, reject) => {
      const dir = join(work, name);
      spawnSync('mkdir', ['-p', dir]);
      const child = nodeSpawn(
        'ffmpeg',
        buildRunArgs({
          url: source,
          startMs,
          audioIndex: source === url ? 0 : -1,
          audioCodec: 'ac3',
          segmentSeconds: 2,
          subtitleStreams,
          ...(transcode ? { transcode } : {}),
        }),
        { cwd: dir, env: minimalEnv() },
      );
      child.on('error', reject);
      let stderr = '';
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('exit', (code) => resolve({ dir, code, stderr }));
    });

  it('writes HLS fMP4 with copied H.264 and AAC converted from AC-3', async () => {
    const { dir, code } = await run(0, 'run1');
    expect(code).toBe(0);
    const files = readdirSync(dir);
    expect(files).toEqual(expect.arrayContaining(['index.m3u8', 'init.mp4', 'seg0.m4s']));
    expect(files.filter((f) => /^seg\d+\.m4s$/.test(f)).length).toBeGreaterThanOrEqual(3);
    const playlist = readFileSync(join(dir, 'index.m3u8'), 'utf8');
    expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(playlist).toContain('#EXTINF');
    expect(playlist).toContain('#EXT-X-ENDLIST');

    // init + first segment make a playable file: the codecs are what a browser needs.
    const joined = join(work, 'joined.mp4');
    writeFileSync(
      joined,
      Buffer.concat([readFileSync(join(dir, 'init.mp4')), readFileSync(join(dir, 'seg0.m4s'))]),
    );
    const media = await probeMedia(nodeSpawn, joined);
    expect(media.video).toMatchObject({ codec: 'h264', height: 240 });
    expect(media.audio[0]).toMatchObject({ codecName: 'aac', channels: 2 });
  });

  it('starting at an offset yields a shorter run; its first segment says where it really starts', async () => {
    const { dir, code } = await run(6_000, 'run2');
    expect(code).toBe(0);
    const playlist = readFileSync(join(dir, 'index.m3u8'), 'utf8');
    const total = [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].reduce((a, m) => a + Number(m[1]), 0);
    // About 6 s remain of the 12 s clip; the run starts at a keyframe before 6 s.
    expect(total).toBeGreaterThan(4.5);
    expect(total).toBeLessThan(8.5);
    // Film time is kept (`-copyts`): the run starts at the keyframe at or before 6 s, and audio
    // with it (`-noaccurate_seek`), so both tracks begin within a frame of each other.
    const start = runStartMs(
      readFileSync(join(dir, 'init.mp4')),
      readFileSync(join(dir, 'seg0.m4s')),
    );
    expect(start).toBeGreaterThan(1_000);
    expect(start).toBeLessThanOrEqual(6_000);
  });

  it('lists the text subtitle track', async () => {
    const media = await probeMedia(nodeSpawn, url);
    expect(media.subtitles).toMatchObject([{ index: 0, streamIndex: 0 }]);
  });

  it('writes WebVTT cues next to the segments, in the film time', async () => {
    const whole = await run(0, 'vtt1', [0]);
    expect(whole.code).toBe(0);
    const vtt = readFileSync(join(whole.dir, 'sub0.vtt'), 'utf8');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('Hello early');
    expect(vtt).toContain('Hello late');
    expect(vtt).toMatch(/00:03\.\d{3} --> 00:05\.\d{3}/);

    // A run that starts at 6 s keeps the film's clock: the cue at 8 s is still at 8 s.
    const later = await run(6_000, 'vtt2', [0]);
    expect(later.code).toBe(0);
    const tail = readFileSync(join(later.dir, 'sub0.vtt'), 'utf8');
    expect(tail).toContain('Hello late');
    expect(tail).not.toContain('Hello early');
    expect(tail).toMatch(/^00:08\.\d{3} --> 00:10\.\d{3}/m);
  });

  it('converts to H.264 in software, with a keyframe at every segment boundary', async () => {
    const { dir, code } = await run(0, 'sw', [], {
      encoder: 'software',
      hwDecode: false,
      device: '',
      tonemap: false,
    });
    expect(code).toBe(0);
    const joined = join(work, 'sw.mp4');
    writeFileSync(
      joined,
      Buffer.concat([readFileSync(join(dir, 'init.mp4')), readFileSync(join(dir, 'seg0.m4s'))]),
    );
    const media = await probeMedia(nodeSpawn, joined);
    expect(media.video).toMatchObject({ codec: 'h264', height: 240 });
    const playlist = readFileSync(join(dir, 'index.m3u8'), 'utf8');
    for (const m of playlist.matchAll(/#EXTINF:([\d.]+)/g)) {
      expect(Number(m[1])).toBeLessThan(2.5);
    }
  });

  it('tone maps a 10-bit PQ source to 8-bit SDR in software', async () => {
    const hdr = join(work, 'hdr.mkv');
    const made = spawnSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=4:size=320x240:rate=25',
        '-vf',
        'format=yuv420p10le',
        '-c:v',
        'libx264',
        '-profile:v',
        'high10',
        '-color_primaries',
        'bt2020',
        '-color_trc',
        'smpte2084',
        '-colorspace',
        'bt2020nc',
        hdr,
      ],
      { encoding: 'utf8' },
    );
    expect(made.stderr).toBe('');
    const probed = await probeMedia(nodeSpawn, hdr);
    expect(probed.video).toMatchObject({ bitDepth: 10, hdr: 'hdr10' });
    const { dir, code, stderr } = await run(
      0,
      'tm',
      [],
      { encoder: 'software', hwDecode: false, device: '', tonemap: true },
      hdr,
    );
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
    const out = join(work, 'tm.mp4');
    writeFileSync(
      out,
      Buffer.concat([readFileSync(join(dir, 'init.mp4')), readFileSync(join(dir, 'seg0.m4s'))]),
    );
    expect((await probeMedia(nodeSpawn, out)).video).toMatchObject({ codec: 'h264', hdr: 'none' });
  });

  // Needs a render node: `VAAPI_DEVICE=/dev/dri/renderD129` with the device passed into the container.
  const device = process.env['VAAPI_DEVICE'] ?? '';
  it.skipIf(!device)('encodes H.264 on the GPU', async () => {
    // GPU decoding with `scale_vaapi` fails on the Dell's HD 530 ("requested VAProfile is not
    // supported"); it is meant for the NUC, so it is tried only when asked for there.
    for (const hwDecode of process.env['VAAPI_HW_DECODE'] ? [false, true] : [false]) {
      // The mp4 muxer may warn about a packet duration; the run must still succeed.
      const { dir, code, stderr } = await run(0, `va-${hwDecode}`, [], {
        encoder: 'vaapi',
        hwDecode,
        device,
        tonemap: false,
      });
      expect({ hwDecode, code, stderr: code ? stderr : '' }).toEqual({
        hwDecode,
        code: 0,
        stderr: '',
      });
      const out = join(work, `va-${hwDecode}.mp4`);
      writeFileSync(
        out,
        Buffer.concat([readFileSync(join(dir, 'init.mp4')), readFileSync(join(dir, 'seg0.m4s'))]),
      );
      expect((await probeMedia(nodeSpawn, out)).video).toMatchObject({ codec: 'h264' });
    }
  });
});
