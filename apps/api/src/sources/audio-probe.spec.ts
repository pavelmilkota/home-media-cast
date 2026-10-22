import { describe, expect, it } from 'vitest';
import {
  UnreadableContainerError,
  languageName,
  probeAudio,
  type RangeReader,
} from './audio-probe.js';
import { box, el, ftyp, id, mkv, mp4Trak, strEl } from './testing/media-fixtures.js';

const reader =
  (file: Buffer): RangeReader =>
  async (start, length) =>
    file.subarray(start, start + length);

describe('probeAudio: Matroska', () => {
  it('lists the audio tracks only, with names, codecs and channels', async () => {
    const file = mkv([
      { type: 1, codec: 'V_MPEGH/ISO/HEVC' },
      { type: 2, codec: 'A_EAC3', lang: 'ukr', name: 'Ukrainian 5.1 Dub', channels: 6 },
      { type: 2, codec: 'A_AAC', lang: 'eng', channels: 2 },
      { type: 17, lang: 'eng' }, // a subtitle track
    ]);
    expect(await probeAudio(reader(file))).toEqual([
      { language: 'Ukrainian', codec: 'E-AC3', channels: 6, title: 'Ukrainian 5.1 Dub' },
      { language: 'English', codec: 'AAC', channels: 2 },
    ]);
  });

  it('prefers the BCP 47 language and leaves "und" unset', async () => {
    const file = mkv([
      { type: 2, codec: 'A_AC3', lang: 'eng', bcp47: 'uk-UA' },
      { type: 2, codec: 'A_DTS', lang: 'und' },
    ]);
    expect(await probeAudio(reader(file))).toEqual([
      { language: 'Ukrainian', codec: 'AC3' },
      { codec: 'DTS' },
    ]);
  });

  it('treats an absent Language as English, as the Matroska spec does', async () => {
    expect(await probeAudio(reader(mkv([{ type: 2, codec: 'A_OPUS' }])))).toEqual([
      { language: 'English', codec: 'Opus' },
    ]);
  });

  it('skips elements before Tracks, across block boundaries', async () => {
    const file = mkv([{ type: 2, codec: 'A_AAC', lang: 'rus' }], 200_000);
    expect(await probeAudio(reader(file))).toEqual([{ language: 'Russian', codec: 'AAC' }]);
  });

  it('gives up when a Cluster comes before any Tracks', async () => {
    const file = Buffer.concat([
      el(0x1a45dfa3, strEl(0x4282, 'matroska')),
      id(0x18538067),
      Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      el(0x1f43b675, Buffer.alloc(100)),
    ]);
    await expect(probeAudio(reader(file))).rejects.toBeInstanceOf(UnreadableContainerError);
  });
});

describe('probeAudio: MP4', () => {
  const moov = box(
    'moov',
    box('mvhd', Buffer.alloc(100)),
    mp4Trak('vide', 'und', 'avc1'),
    mp4Trak('soun', 'ukr', 'ec-3', 6),
    mp4Trak('soun', 'eng', 'mp4a', 2),
  );
  const mdat = box('mdat', Buffer.alloc(400_000));

  it('reads a file with moov first', async () => {
    expect(await probeAudio(reader(Buffer.concat([ftyp, moov, mdat])))).toEqual([
      { language: 'Ukrainian', codec: 'E-AC3', channels: 6 },
      { language: 'English', codec: 'AAC', channels: 2 },
    ]);
  });

  it('finds a moov after a large mdat without reading the mdat', async () => {
    const file = Buffer.concat([ftyp, mdat, moov]);
    const reads: number[] = [];
    const spy: RangeReader = async (start, length) => {
      reads.push(length);
      return reader(file)(start, length);
    };
    expect(await probeAudio(spy)).toHaveLength(2);
    expect(reads.reduce((a, b) => a + b, 0)).toBeLessThan(1_000_000);
  });

  it('leaves an unset language unset', async () => {
    const file = Buffer.concat([ftyp, box('moov', mp4Trak('soun', 'und'))]);
    expect(await probeAudio(reader(file))).toEqual([{ codec: 'AAC', channels: 2 }]);
  });
});

describe('probeAudio: other files', () => {
  it('rejects what is neither Matroska nor MP4', async () => {
    await expect(probeAudio(reader(Buffer.from('RIFF....AVI LIST')))).rejects.toBeInstanceOf(
      UnreadableContainerError,
    );
  });

  it('rejects an empty answer', async () => {
    await expect(probeAudio(reader(Buffer.alloc(0)))).rejects.toBeInstanceOf(
      UnreadableContainerError,
    );
  });
});

describe('languageName', () => {
  it('names ISO 639-1/-2 codes, including the bibliographic ones', () => {
    expect(languageName('ukr')).toBe('Ukrainian');
    expect(languageName('ger')).toBe('German');
    expect(languageName('FRA')).toBe('French');
    expect(languageName('pt-BR')).toBe('Portuguese');
    expect(languageName('uk')).toBe('Ukrainian');
  });

  it('returns undefined for unset or unknown codes', () => {
    for (const c of ['und', 'mul', 'zxx', '', undefined, 'x', 'toolong', '12']) {
      expect(languageName(c)).toBeUndefined();
    }
  });
});
