import { describe, expect, it } from 'vitest';
import { readInit, runStartMs, withoutEditLists } from './fmp4.js';

const box = (type: string, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};
const u32 = (...values: number[]) => {
  const b = Buffer.alloc(4 * values.length);
  values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4));
  return b;
};
const u64 = (v: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(v));
  return b;
};

/** version 0 boxes, as ffmpeg writes them; `delay` is an empty edit in the movie timescale. */
const trak = (id: number, timescale: number, delay?: number) =>
  box(
    'trak',
    box('tkhd', u32(3, 0, 0, id), Buffer.alloc(72)),
    ...(delay === undefined
      ? []
      : [box('edts', box('elst', u32(0, 2, delay, 0xffffffff, 0x10000, 1000, 0, 0x10000)))]),
    box('mdia', box('mdhd', u32(0, 0, 0, timescale, 0, 0))),
  );
const init = (...traks: Buffer[]) =>
  Buffer.concat([
    box('ftyp', Buffer.from('iso5')),
    box('moov', box('mvhd', u32(0, 0, 0, 1000), Buffer.alloc(84)), ...traks),
  ]);
const traf = (id: number, decode: number) =>
  box('traf', box('tfhd', u32(0x20000, id)), box('tfdt', u32(0x01000000), u64(decode)));
const segment = (...trafs: Buffer[]) =>
  Buffer.concat([box('styp', Buffer.from('msdh')), box('moof', box('mfhd', u32(0, 1)), ...trafs)]);

describe('fmp4', () => {
  it('reads timescales and empty edits from the init segment', () => {
    const tracks = readInit(init(trak(1, 12_800, 60_006), trak(2, 44_100)));
    expect(tracks.get(1)).toEqual({ timescale: 12_800, delayMs: 60_006 });
    expect(tracks.get(2)).toEqual({ timescale: 44_100, delayMs: 0 });
  });

  it('a copy run starts at the earliest track: the keyframe before the seek point', () => {
    const start = runStartMs(
      init(trak(1, 12_800, 60_006), trak(2, 44_100, 59_988)),
      segment(traf(1, 0), traf(2, 0)),
    );
    expect(start).toBe(59_988);
  });

  it('adds the decode time of the first fragment', () => {
    expect(runStartMs(init(trak(1, 1000)), segment(traf(1, 1500)))).toBe(1500);
  });

  it('gives undefined for anything it cannot read, never throws', () => {
    expect(runStartMs(Buffer.alloc(0), Buffer.alloc(0))).toBeUndefined();
    expect(runStartMs(Buffer.from('garbage-garbage'), Buffer.alloc(3))).toBeUndefined();
    const truncated = init(trak(1, 1000)).subarray(0, 40);
    expect(runStartMs(truncated, segment(traf(1, 0)))).toBeUndefined();
  });

  describe('withoutEditLists', () => {
    const withEdits = () =>
      Buffer.concat([
        init(trak(1, 24_000, 1_724_514), trak(2, 48_000, 1_724_522)),
        box('udta', Buffer.from('kept')),
      ]);

    it('drops every edit list and fixes the sizes; the rest stays byte for byte', () => {
      const clean = withoutEditLists(withEdits());
      expect(clean).toBeDefined();
      expect(clean).toEqual(
        Buffer.concat([init(trak(1, 24_000), trak(2, 48_000)), box('udta', Buffer.from('kept'))]),
      );
      const tracks = readInit(clean as Buffer);
      expect(tracks.get(1)).toEqual({ timescale: 24_000, delayMs: 0 });
      expect(tracks.get(2)).toEqual({ timescale: 48_000, delayMs: 0 });
    });

    it('does nothing more the second time, and nothing to a segment without edits', () => {
      const once = withoutEditLists(withEdits()) as Buffer;
      expect(withoutEditLists(once)).toEqual(once);
      const plain = init(trak(1, 1000));
      expect(withoutEditLists(plain)).toEqual(plain);
    });

    it('the start is still read from the original', () => {
      const original = withEdits();
      withoutEditLists(original);
      expect(runStartMs(original, segment(traf(1, 0), traf(2, 0)))).toBe(1_724_514);
    });

    it('gives undefined for anything it cannot read with certainty, never throws', () => {
      expect(withoutEditLists(Buffer.alloc(0))).toBeUndefined();
      expect(withoutEditLists(Buffer.from('garbage-garbage'))).toBeUndefined();
      expect(withoutEditLists(withEdits().subarray(0, 60))).toBeUndefined();
      expect(withoutEditLists(box('ftyp', Buffer.from('iso5')))).toBeUndefined();
    });
  });
});
