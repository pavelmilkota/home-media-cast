import { describe, expect, it } from 'vitest';
import {
  FfmpegMissingError,
  ProbeError,
  buildProbeArgs,
  buildRunArgs,
  maskLine,
  minimalEnv,
  parseProbe,
  probeMedia,
  type SpawnFn,
} from './ffmpeg.js';
import { FakeProcess, createFakeSpawn, probeJson } from './testing/fake-ffmpeg.js';

const URL_ = 'http://127.0.0.1:8787/api/relay/abc123';
const plan = { url: URL_, startMs: 0, audioIndex: 0, audioCodec: 'aac' };

describe('buildRunArgs', () => {
  it('copies the video and the audio when the audio is already AAC', () => {
    const args = buildRunArgs(plan);
    expect(args).toEqual(expect.arrayContaining(['-c:v', 'copy', '-c:a', 'copy']));
    expect(args).not.toContain('-ss');
    expect(args.slice(args.indexOf('-i'), args.indexOf('-i') + 2)).toEqual(['-i', URL_]);
  });

  it('converts any other audio to stereo AAC', () => {
    const args = buildRunArgs({ ...plan, audioCodec: 'eac3' });
    expect(args.join(' ')).toContain('-c:a aac -b:a 192k -ac 2');
    expect(args).not.toContain('copy -c:a');
  });

  it('seeks on the input, before -i, in seconds with milliseconds', () => {
    const args = buildRunArgs({ ...plan, startMs: 83_250 });
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual(['-ss', '83.250']);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
  });

  it('maps the chosen audio stream by its ordinal', () => {
    const args = buildRunArgs({ ...plan, audioIndex: 2, audioCodec: 'ac3' });
    expect(args.join(' ')).toContain('-map 0:v:0 -map 0:a:2');
  });

  it('maps no audio for a file without any, and drops the audio codec options', () => {
    const args = buildRunArgs({ ...plan, audioIndex: -1, audioCodec: '' });
    expect(args.join(' ')).toContain('-map 0:v:0 -sn');
    expect(args).not.toContain('-c:a');
    expect(args.filter((a) => a === '-map')).toHaveLength(1);
  });

  it('writes fMP4 HLS under fixed relative names, with no path in the arguments', () => {
    const args = buildRunArgs(plan);
    expect(args.join(' ')).toContain('-f hls');
    expect(args.join(' ')).toContain('-hls_segment_type fmp4');
    expect(args.slice(-3)).toEqual(['-hls_segment_filename', 'seg%d.m4s', 'index.m3u8']);
    expect(args.some((a) => a.startsWith('/') && a !== '' && !a.startsWith('http'))).toBe(false);
  });

  it('allows only http, tcp and file, and sets an input timeout', () => {
    for (const args of [buildRunArgs(plan), buildProbeArgs(URL_)]) {
      expect(
        args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2),
      ).toEqual(['-protocol_whitelist', 'http,tcp,file']);
      expect(args).toContain('-rw_timeout');
    }
  });

  it('holds only the relay URL, integers and fixed strings', () => {
    const args = buildRunArgs({ ...plan, startMs: 1500.7, audioIndex: 1, audioCodec: 'dts' });
    const fixed = /^(-[a-z_:0-9]+|[a-z0-9_.%:+]+|\d+(\.\d+)?|copy|aac|192k|http,tcp,file)$/i;
    expect(args.filter((a) => a !== URL_ && !fixed.test(a))).toEqual([]);
  });
});

describe('buildRunArgs: transcoding', () => {
  const sw = {
    encoder: 'software',
    hwDecode: false,
    device: '/dev/dri/renderD129',
    tonemap: false,
  } as const;
  const va = { ...sw, encoder: 'vaapi' } as const;
  const line = (a: string[]) => a.join(' ');

  it('encodes libx264 in software with keyframes at the segment interval', () => {
    const args = buildRunArgs({ ...plan, transcode: sw });
    expect(line(args)).toContain('-c:v libx264 -preset veryfast');
    expect(line(args)).toContain(
      '-force_key_frames expr:if(isnan(prev_forced_t),1,gte(t,prev_forced_t+4))',
    );
    expect(line(args)).toContain('-vf format=yuv420p');
    expect(line(args)).not.toContain('-c:v copy');
    expect(args).not.toContain('-init_hw_device');
  });

  it('uploads software-decoded frames to the GPU for VAAPI', () => {
    const args = buildRunArgs({ ...plan, transcode: va });
    expect(line(args)).toContain(
      '-init_hw_device vaapi=va:/dev/dri/renderD129 -filter_hw_device va',
    );
    expect(line(args)).toContain('-vf format=nv12,hwupload -c:v h264_vaapi');
    expect(args.indexOf('-init_hw_device')).toBeLessThan(args.indexOf('-i'));
    expect(args).not.toContain('-hwaccel');
  });

  it('decodes on the GPU too when asked', () => {
    const args = buildRunArgs({ ...plan, transcode: { ...va, hwDecode: true } });
    expect(line(args)).toContain('-hwaccel vaapi -hwaccel_device /dev/dri/renderD129');
    expect(line(args)).toContain('-hwaccel_output_format vaapi');
    expect(line(args)).toContain('-vf scale_vaapi=format=nv12 -c:v h264_vaapi');
    expect(args.indexOf('-hwaccel')).toBeLessThan(args.indexOf('-i'));
  });

  it('tone maps HDR to SDR in every pipeline', () => {
    const soft = line(buildRunArgs({ ...plan, transcode: { ...sw, tonemap: true } }));
    expect(soft).toContain('tonemap=tonemap=hable');
    const upload = line(buildRunArgs({ ...plan, transcode: { ...va, tonemap: true } }));
    expect(upload).toContain('tonemap=tonemap=hable');
    expect(upload).toContain('format=nv12,hwupload');
    const hw = line(buildRunArgs({ ...plan, transcode: { ...va, hwDecode: true, tonemap: true } }));
    expect(hw).toContain('tonemap_vaapi=');
  });

  it('still maps and converts the audio', () => {
    const args = buildRunArgs({ ...plan, audioCodec: 'eac3', audioIndex: 1, transcode: sw });
    expect(line(args)).toContain('-map 0:a:1');
    expect(line(args)).toContain('-c:a aac -b:a 192k -ac 2');
  });

  it('puts only fixed strings and integers in the arguments', () => {
    const args = buildRunArgs({ ...plan, transcode: { ...va, hwDecode: true, tonemap: true } });
    expect(args.some((a) => /[;|&$`]/.test(a))).toBe(false);
  });
});

describe('buildRunArgs: subtitles', () => {
  it('writes each text subtitle to its own WebVTT file before the HLS output', () => {
    const args = buildRunArgs({ ...plan, subtitleStreams: [2, 5] });
    const text = args.join(' ');
    expect(text).toContain(
      '-map 0:s:2 -c:s webvtt -flush_packets 1 -f webvtt sub0.vtt -map 0:s:5 -c:s webvtt -flush_packets 1 -f webvtt sub1.vtt',
    );
    expect(text.indexOf('sub1.vtt')).toBeLessThan(text.indexOf('-map 0:v:0'));
    expect(args.slice(-3)).toEqual(['-hls_segment_filename', 'seg%d.m4s', 'index.m3u8']);
  });

  it('writes at most 12 and none by default', () => {
    expect(buildRunArgs(plan).some((a) => a.endsWith('.vtt'))).toBe(false);
    const many = buildRunArgs({
      ...plan,
      subtitleStreams: Array.from({ length: 20 }, (_, i) => i),
    });
    expect(many.filter((a) => a.endsWith('.vtt'))).toHaveLength(12);
  });
});

describe('minimalEnv', () => {
  it('passes PATH and a locale, and nothing else', () => {
    const env = minimalEnv({
      PATH: '/usr/bin',
      AIOSTREAMS_PASSWORD: 'secret',
      TORBOX_API_KEY: 'key',
      HOME: '/root',
    });
    expect(env).toEqual({ PATH: '/usr/bin', LANG: 'C.UTF-8' });
  });

  it('passes the VAAPI driver choice when it looks like a driver name', () => {
    expect(minimalEnv({ PATH: '/bin', LIBVA_DRIVER_NAME: 'iHD' })).toMatchObject({
      LIBVA_DRIVER_NAME: 'iHD',
    });
    expect(minimalEnv({ PATH: '/bin', LIBVA_DRIVER_NAME: 'x; rm -rf /' })).not.toHaveProperty(
      'LIBVA_DRIVER_NAME',
    );
  });
});

describe('maskLine', () => {
  it('masks relay ids, secrets and long lines', () => {
    const line = `Opening 'http://127.0.0.1:8787/api/relay/ID-SECRET-1' token=abc123 for reading`;
    const out = maskLine(line, ['ID-SECRET-1']);
    expect(out).not.toContain('ID-SECRET-1');
    expect(out).not.toContain('abc123');
    expect(maskLine('x'.repeat(1000))).toHaveLength(300);
  });
});

describe('parseProbe', () => {
  it('reads duration, video facts and the audio and subtitle tracks', () => {
    const media = parseProbe(probeJson());
    expect(media.durationMs).toBe(7_200_500);
    expect(media.video).toEqual({ codec: 'h264', height: 1080, hdr: 'none' });
    expect(media.audio).toEqual([
      { index: 0, codecName: 'eac3', codec: 'EAC3', channels: 6, language: 'ukr', title: 'Dub' },
      { index: 1, codecName: 'aac', codec: 'AAC', channels: 2, language: 'eng' },
    ]);
    expect(media.subtitles).toEqual([{ index: 0, streamIndex: 0, language: 'eng' }]);
  });

  it('reads 10-bit HEVC with HDR10 and Dolby Vision', () => {
    const json = probeJson({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'hevc',
          height: 2160,
          pix_fmt: 'yuv420p10le',
          color_transfer: 'smpte2084',
          side_data_list: [{ side_data_type: 'DOVI configuration record' }],
        },
      ],
    });
    expect(parseProbe(json).video).toEqual({
      codec: 'hevc',
      height: 2160,
      bitDepth: 10,
      hdr: 'dv-fallback',
    });
  });

  it('names a codec it does not know "other", and ignores cover art', () => {
    const json = probeJson({
      streams: [
        { codec_type: 'video', codec_name: 'mpeg4', disposition: { attached_pic: 1 } },
        { codec_type: 'video', codec_name: 'mpeg4', height: 480 },
      ],
    });
    expect(parseProbe(json).video).toMatchObject({ codec: 'other', height: 480 });
  });

  it('lists text subtitles only, keeping the stream ordinal for mapping', () => {
    const json = probeJson({
      streams: [
        { codec_type: 'video', codec_name: 'h264' },
        { codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } },
        { codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'pol' } },
        { codec_type: 'subtitle', codec_name: 'dvd_subtitle' },
        { codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'ukr' } },
      ],
    });
    expect(parseProbe(json).subtitles).toEqual([
      { index: 0, streamIndex: 1, language: 'pol' },
      { index: 1, streamIndex: 3, language: 'ukr' },
    ]);
  });

  it('refuses a file without video or without a length', () => {
    expect(() => parseProbe(probeJson({ streams: [] }))).toThrow(ProbeError);
    expect(() => parseProbe(probeJson({ format: {} }))).toThrow(ProbeError);
    expect(() => parseProbe(null)).toThrow(ProbeError);
  });

  it('drops an "und" language and keeps tracks bounded', () => {
    const many = Array.from({ length: 50 }, () => ({
      codec_type: 'audio',
      codec_name: 'aac',
      tags: { language: 'und' },
    }));
    const media = parseProbe(
      probeJson({ streams: [{ codec_type: 'video', codec_name: 'h264' }, ...many] }),
    );
    expect(media.audio).toHaveLength(32);
    expect(media.audio[0]).not.toHaveProperty('language');
  });
});

describe('probeMedia', () => {
  it('runs ffprobe with the relay URL and a minimal environment', async () => {
    const fake = createFakeSpawn();
    const media = await probeMedia(fake.spawn, URL_);
    expect(media.audio).toHaveLength(2);
    const [proc] = fake.processes;
    expect(proc?.file).toBe('ffprobe');
    expect(proc?.args.at(-1)).toBe(URL_);
    expect(Object.keys(proc?.options.env ?? {}).sort()).toEqual(['LANG', 'PATH']);
  });

  it('rejects with a message that has no URL when ffprobe fails, and logs masked stderr', async () => {
    const fake = createFakeSpawn();
    fake.probe.fail = true;
    const logged: string[] = [];
    const error = await probeMedia(fake.spawn, URL_, {}, (l) => logged.push(l)).catch((e) => e);
    expect(error).toBeInstanceOf(ProbeError);
    expect(String(error.message)).not.toContain('127.0.0.1');
    expect(logged.join()).toContain('Invalid data');
  });

  it('reports a missing binary', async () => {
    const error = await probeMedia(() => {
      throw new Error('spawn ffprobe ENOENT');
    }, URL_).catch((e) => e);
    expect(error).toBeInstanceOf(FfmpegMissingError);
  });

  it('kills ffprobe that takes too long', async () => {
    let silent: FakeProcess | undefined;
    const spawn: SpawnFn = (file, args, options) => (silent = new FakeProcess(file, args, options));
    const error = await probeMedia(spawn, URL_, { timeoutMs: 30 }).catch((e) => e);
    expect(error).toBeInstanceOf(ProbeError);
    expect(silent?.signals).toContain('SIGKILL');
  });
});
