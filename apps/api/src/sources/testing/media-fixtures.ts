/** Builds the bytes of tiny Matroska and MP4 files, so tests need no media tools or binaries. */

function size(n: number): Buffer {
  if (n < 127) return Buffer.from([0x80 | n]);
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  b[0] = (b[0] as number) | 0x10; // 4-byte size marker
  return b;
}
export const id = (n: number): Buffer => {
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
};
export const el = (n: number, ...body: Buffer[]): Buffer => {
  const b = Buffer.concat(body);
  return Buffer.concat([id(n), size(b.length), b]);
};
const uintEl = (n: number, v: number) => el(n, Buffer.from([v]));
export const strEl = (n: number, s: string) => el(n, Buffer.from(s));

export interface MkvTrack {
  type: number;
  codec?: string;
  lang?: string;
  bcp47?: string;
  name?: string;
  channels?: number;
  /** Video track details (type 1). */
  height?: number;
  /** Colour transfer characteristics: 16 = PQ (HDR10), 18 = HLG. */
  transfer?: number;
  bits?: number;
  /** First profile byte of the codec private record (HEVC: 1 = Main, 2 = Main 10). */
  profile?: number;
  dolbyVision?: boolean;
}
const uintN = (n: number, v: number) => el(n, Buffer.from(v > 255 ? [v >> 8, v & 255] : [v]));
const mkvTrack = (t: MkvTrack): Buffer =>
  el(
    0xae,
    uintEl(0x83, t.type),
    ...(t.codec ? [strEl(0x86, t.codec)] : []),
    ...(t.lang ? [strEl(0x22b59c, t.lang)] : []),
    ...(t.bcp47 ? [strEl(0x22b59d, t.bcp47)] : []),
    ...(t.name ? [strEl(0x536e, t.name)] : []),
    ...(t.channels ? [el(0xe1, uintEl(0x9f, t.channels))] : []),
    ...(t.profile ? [el(0x63a2, Buffer.from([1, t.profile]))] : []),
    ...(t.dolbyVision ? [el(0x41e4, el(0x41e7, Buffer.from('dvcC')))] : []),
    ...(t.height || t.transfer || t.bits
      ? [
          el(
            0xe0,
            ...(t.height ? [uintN(0xba, t.height)] : []),
            ...(t.transfer || t.bits
              ? [
                  el(
                    0x55b0,
                    ...(t.transfer ? [uintEl(0x55ba, t.transfer)] : []),
                    ...(t.bits ? [uintEl(0x55b2, t.bits)] : []),
                  ),
                ]
              : []),
          ),
        ]
      : []),
  );

/** EBML header, a Segment holding SeekHead-ish padding, Tracks, then a Cluster. */
export function mkv(tracks: MkvTrack[], padding = 0): Buffer {
  const segment = Buffer.concat([
    el(0xec, Buffer.alloc(padding)), // a Void element before Tracks
    el(0x1654ae6b, ...tracks.map(mkvTrack)),
    el(0x1f43b675, Buffer.alloc(300_000)), // the Cluster: the video, never read
  ]);
  return Buffer.concat([
    el(0x1a45dfa3, strEl(0x4282, 'matroska')),
    id(0x18538067),
    Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), // unknown size
    segment,
  ]);
}

export const box = (type: string, ...body: Buffer[]): Buffer => {
  const b = Buffer.concat(body);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(b.length + 8);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, b]);
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const packLang = (c: string) =>
  [...c].reduce((acc, ch) => (acc << 5) | (ch.charCodeAt(0) - 0x60), 0);

export function mp4Trak(handler: string, lang: string, format = 'mp4a', channels = 2): Buffer {
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt16BE(packLang(lang), 20);
  const hdlr = Buffer.concat([u32(0), u32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12)]);
  const entry = Buffer.alloc(28);
  entry.writeUInt32BE(28);
  entry.write(format, 4, 'latin1');
  entry.writeUInt16BE(channels, 24);
  const stsd = Buffer.concat([u32(0), u32(1), entry]);
  return box(
    'trak',
    box('tkhd', Buffer.alloc(84)),
    box(
      'mdia',
      box('mdhd', mdhd),
      box('hdlr', hdlr),
      box('minf', box('smhd', Buffer.alloc(8)), box('stbl', box('stsd', stsd))),
    ),
  );
}

export const ftyp = box('ftyp', Buffer.from('isom'), u32(0), Buffer.from('isom'));

/** A video track whose sample entry names `format`, is `height` tall and has `children` boxes. */
export function mp4VideoTrak(format: string, height: number, ...children: Buffer[]): Buffer {
  const mdhd = Buffer.alloc(24);
  const hdlr = Buffer.concat([u32(0), u32(0), Buffer.from('vide', 'latin1'), Buffer.alloc(12)]);
  const visual = Buffer.alloc(70); // sample entry bytes 16..86: width at 16, height at 18
  visual.writeUInt16BE(1920, 16);
  visual.writeUInt16BE(height, 18);
  const body = Buffer.concat([Buffer.alloc(6), Buffer.from([0, 1]), visual, ...children]);
  const entry = Buffer.concat([u32(8 + body.length), Buffer.from(format, 'latin1'), body]);
  const stsd = Buffer.concat([u32(0), u32(1), entry]);
  return box(
    'trak',
    box('tkhd', Buffer.alloc(84)),
    box(
      'mdia',
      box('mdhd', mdhd),
      box('hdlr', hdlr),
      box('minf', box('vmhd', Buffer.alloc(8)), box('stbl', box('stsd', stsd))),
    ),
  );
}

/** `colr` box with `nclx` colour information and the given transfer characteristics. */
export const colr = (transfer: number): Buffer => {
  const b = Buffer.alloc(11);
  b.write('nclx', 0, 'latin1');
  b.writeUInt16BE(transfer, 6);
  return box('colr', b);
};
