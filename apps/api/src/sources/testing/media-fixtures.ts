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
}
const mkvTrack = (t: MkvTrack): Buffer =>
  el(
    0xae,
    uintEl(0x83, t.type),
    ...(t.codec ? [strEl(0x86, t.codec)] : []),
    ...(t.lang ? [strEl(0x22b59c, t.lang)] : []),
    ...(t.bcp47 ? [strEl(0x22b59d, t.bcp47)] : []),
    ...(t.name ? [strEl(0x536e, t.name)] : []),
    ...(t.channels ? [el(0xe1, uintEl(0x9f, t.channels))] : []),
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
