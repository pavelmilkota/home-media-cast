import type { AudioTrack, VideoFacts } from '@home-media-cast/shared';

/** What the header of a file says about its tracks. `video` is absent when it names none. */
export interface ProbedTracks {
  audio: AudioTrack[];
  video?: VideoFacts;
}

/**
 * Reads the audio tracks and the video facts out of the first bytes of a video file (Matroska/WebM or MP4/MOV),
 * through ranged reads, so a file is never downloaded. The bytes come from a remote server and
 * are untrusted: every length is bounded and every string is cut.
 */

/** Reads up to `length` bytes at `start`; shorter (or empty) at the end of the file. */
export type RangeReader = (start: number, length: number) => Promise<Buffer>;

/** The file is not Matroska or MP4, or the part that lists the tracks could not be found. */
export class UnreadableContainerError extends Error {
  override readonly name = 'UnreadableContainerError';
}

const BLOCK = 128 * 1024;
/** The Matroska `Tracks` element and each MP4 box we read whole stay below this. */
const MAX_ELEMENT = 1024 * 1024;
const MAX_TRACKS = 32;
const MAX_TEXT = 60;

/** Caches fixed-size blocks, so the many small header reads of a walk cost few requests. */
function blocked(read: RangeReader): RangeReader {
  const blocks = new Map<number, Promise<Buffer>>();
  const block = (index: number) => {
    let b = blocks.get(index);
    if (!b) {
      b = read(index * BLOCK, BLOCK);
      blocks.set(index, b);
    }
    return b;
  };
  return async (start, length) => {
    const parts: Buffer[] = [];
    for (let i = Math.floor(start / BLOCK); i * BLOCK < start + length; i++) {
      const data = await block(i);
      parts.push(data);
      if (data.length < BLOCK) break; // end of file
    }
    const all = Buffer.concat(parts);
    const skip = start - Math.floor(start / BLOCK) * BLOCK;
    return all.subarray(skip, skip + length);
  };
}

const text = (b: Buffer): string | undefined => {
  const s = b.toString('utf8').replace(/\0.*$/s, '').trim();
  return s ? s.slice(0, MAX_TEXT) : undefined;
};

// ---------------------------------------------------------------------------------- Matroska

const MKV = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  tracks: 0x1654ae6b,
  cluster: 0x1f43b675,
  trackEntry: 0xae,
  trackType: 0x83,
  codecId: 0x86,
  language: 0x22b59c,
  languageBcp47: 0x22b59d,
  name: 0x536e,
  audio: 0xe1,
  channels: 0x9f,
  video: 0xe0,
  pixelHeight: 0xba,
  colour: 0x55b0,
  bitsPerChannel: 0x55b2,
  transfer: 0x55ba,
  codecPrivate: 0x63a2,
  blockAdditionMapping: 0x41e4,
} as const;

interface Header {
  id: number;
  /** Bytes of the id and size fields. */
  header: number;
  /** `undefined` when the size is "unknown". */
  size: number | undefined;
}

function ebmlHeader(b: Buffer, at: number): Header | undefined {
  const first = b[at];
  if (first === undefined || first === 0) return undefined;
  const idLen = Math.clz32(first) - 23; // leading zeros of the byte, plus one
  if (idLen > 4 || at + idLen >= b.length) return undefined;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + (b[at + i] as number);
  const sizeAt = at + idLen;
  const s0 = b[sizeAt];
  if (s0 === undefined || s0 === 0) return undefined;
  const sizeLen = Math.clz32(s0) - 23;
  if (sizeAt + sizeLen > b.length) return undefined;
  let size = s0 & (0xff >> sizeLen);
  let allOnes = size === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) {
    const v = b[sizeAt + i] as number;
    size = size * 256 + v;
    allOnes &&= v === 0xff;
  }
  return { id, header: idLen + sizeLen, size: allOnes ? undefined : size };
}

const uint = (b: Buffer): number => {
  let n = 0;
  for (const v of b.subarray(0, 8)) n = n * 256 + v;
  return n;
};

function mkvChildren(
  b: Buffer,
  start: number,
  end: number,
  visit: (h: Header, at: number) => void,
) {
  let at = start;
  while (at < end) {
    const h = ebmlHeader(b, at);
    if (!h || h.size === undefined) return;
    const body = at + h.header;
    visit(h, body);
    at = body + h.size;
  }
}

/** Transfer characteristics 16 (PQ) and 18 (HLG): what a screen needs HDR support for. */
const HDR_TRANSFER = new Set([16, 18]);

interface VideoDraft {
  codecId?: string | undefined;
  height?: number | undefined;
  bits?: number | undefined;
  transfer?: number | undefined;
  dolbyVision?: boolean | undefined;
  /** Profile byte of the `avcC` / `hvcC` record. */
  profile?: number | undefined;
}

/** Turns what a header said into `VideoFacts`; fields it did not say stay absent. */
function videoFacts(codec: VideoFacts['codec'], d: VideoDraft): VideoFacts {
  let bitDepth = d.bits;
  if (bitDepth === undefined && d.profile !== undefined) {
    if (codec === 'hevc') bitDepth = d.profile === 2 ? 10 : d.profile === 1 ? 8 : undefined;
    else if (codec === 'h264')
      bitDepth = d.profile === 110 ? 10 : [66, 77, 88, 100].includes(d.profile) ? 8 : undefined;
  }
  const hdr10 = d.transfer !== undefined && HDR_TRANSFER.has(d.transfer);
  return {
    ...(codec ? { codec } : {}),
    ...(d.height && d.height > 0 && d.height < 20000 ? { height: d.height } : {}),
    ...(bitDepth ? { bitDepth } : {}),
    // Dolby Vision on a PQ base layer (profiles 7, 8.1) plays as HDR10 on a screen without DV.
    hdr: d.dolbyVision ? (hdr10 ? 'dv-fallback' : 'dv') : hdr10 ? 'hdr10' : 'none',
  };
}

const MKV_VIDEO_CODECS: [RegExp, NonNullable<VideoFacts['codec']>][] = [
  [/^V_MPEG4\/ISO\/AVC/, 'h264'],
  [/^V_MPEGH\/ISO\/HEVC/, 'hevc'],
  [/^V_VP9/, 'vp9'],
  [/^V_AV1/, 'av1'],
];

function mkvTracks(b: Buffer): ProbedTracks {
  const tracks: AudioTrack[] = [];
  let video: VideoFacts | undefined;
  let seen = 0;
  mkvChildren(b, 0, b.length, (h, at) => {
    if (h.id !== MKV.trackEntry || seen++ >= MAX_TRACKS) return;
    const end = Math.min(at + (h.size as number), b.length);
    let type = 0;
    let codec: string | undefined;
    let lang = 'eng'; // the Matroska default when the element is absent
    let bcp47: string | undefined;
    let title: string | undefined;
    let channels: number | undefined;
    const draft: VideoDraft = {};
    mkvChildren(b, at, end, (c, cat) => {
      const body = b.subarray(cat, Math.min(cat + (c.size as number), end));
      if (c.id === MKV.trackType) type = uint(body);
      else if (c.id === MKV.codecId) codec = text(body);
      else if (c.id === MKV.language) lang = text(body) ?? lang;
      else if (c.id === MKV.languageBcp47) bcp47 = text(body);
      else if (c.id === MKV.name) title = text(body);
      else if (c.id === MKV.codecPrivate) draft.profile = body[1];
      else if (c.id === MKV.blockAdditionMapping) {
        mkvChildren(body, 0, body.length, (m, mat) => {
          // BlockAddIDType: 'dvcC' or 'dvvC' is the Dolby Vision configuration record.
          if (m.id === 0x41e7) {
            const t = uint(body.subarray(mat, mat + (m.size as number)));
            if (t === 0x64766343 || t === 0x64767643) draft.dolbyVision = true;
          }
        });
      } else if (c.id === MKV.audio) {
        mkvChildren(body, 0, body.length, (a, aat) => {
          if (a.id === MKV.channels) channels = uint(body.subarray(aat, aat + (a.size as number)));
        });
      } else if (c.id === MKV.video) {
        mkvChildren(body, 0, body.length, (v, vat) => {
          const vb = body.subarray(vat, vat + (v.size as number));
          if (v.id === MKV.pixelHeight) draft.height = uint(vb);
          else if (v.id === MKV.colour) {
            mkvChildren(vb, 0, vb.length, (k, kat) => {
              const kb = vb.subarray(kat, kat + (k.size as number));
              if (k.id === MKV.transfer) draft.transfer = uint(kb);
              else if (k.id === MKV.bitsPerChannel) draft.bits = uint(kb) || undefined;
            });
          }
        });
      }
    });
    if (type === 1 && !video) {
      draft.codecId = codec;
      const family = MKV_VIDEO_CODECS.find(([re]) => re.test(codec ?? ''))?.[1];
      video = videoFacts(codec ? (family ?? 'other') : undefined, draft);
    } else if (type === 2 && tracks.length < MAX_TRACKS) {
      tracks.push(track({ code: bcp47 ?? lang, codec: mkvCodec(codec), channels, title }));
    }
  });
  return { audio: tracks, ...(video ? { video } : {}) };
}

const MKV_CODECS: [RegExp, string][] = [
  [/^A_AAC/, 'AAC'],
  [/^A_EAC3/, 'E-AC3'],
  [/^A_AC3/, 'AC3'],
  [/^A_DTS/, 'DTS'],
  [/^A_TRUEHD/, 'TrueHD'],
  [/^A_OPUS/, 'Opus'],
  [/^A_VORBIS/, 'Vorbis'],
  [/^A_FLAC/, 'FLAC'],
  [/^A_MPEG\/L3/, 'MP3'],
];
const mkvCodec = (id: string | undefined): string | undefined =>
  id ? (MKV_CODECS.find(([re]) => re.test(id))?.[1] ?? id.replace(/^A_/, '')) : undefined;

async function probeMatroska(read: RangeReader): Promise<ProbedTracks> {
  const top = await read(0, 64);
  const ebml = ebmlHeader(top, 0);
  if (!ebml || ebml.size === undefined) throw new UnreadableContainerError('Bad EBML header');
  let at = ebml.header + ebml.size;
  const seg = ebmlHeader(await read(at, 16), 0);
  if (!seg || seg.id !== MKV.segment) throw new UnreadableContainerError('No Segment');
  at += seg.header;
  // Walk the Segment's children until Tracks; the Clusters (the video itself) come after it.
  for (let hops = 0; hops < 32; hops++) {
    const buf = await read(at, 16);
    const h = ebmlHeader(buf, 0);
    if (!h || h.id === MKV.cluster || h.size === undefined) break;
    if (h.id === MKV.tracks) {
      if (h.size > MAX_ELEMENT) break;
      return mkvTracks(await read(at + h.header, h.size));
    }
    at += h.header + h.size;
  }
  throw new UnreadableContainerError('No Tracks before the first Cluster');
}

// ------------------------------------------------------------------------------------- MP4

const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
const MP4_CODECS: Record<string, string> = {
  mp4a: 'AAC',
  'ac-3': 'AC3',
  'ec-3': 'E-AC3',
  Opus: 'Opus',
  fLaC: 'FLAC',
  dtsc: 'DTS',
  dtsh: 'DTS',
  dtsl: 'DTS',
  '.mp3': 'MP3',
};

interface Mp4Track {
  handler?: string;
  code?: string;
  codec?: string;
  channels?: number;
  video?: VideoFacts;
}

const MP4_VIDEO_CODECS: Record<string, NonNullable<VideoFacts['codec']>> = {
  avc1: 'h264',
  avc3: 'h264',
  hvc1: 'hevc',
  hev1: 'hevc',
  dvh1: 'hevc',
  dvhe: 'hevc',
  vp09: 'vp9',
  av01: 'av1',
  dav1: 'av1',
};

/** The video sample entry of an `stsd` box body (the box's children start 94 bytes in). */
function mp4Video(b: Buffer): VideoFacts {
  const format = b.toString('latin1', 12, 16);
  const draft: VideoDraft = {
    height: b.length >= 44 ? b.readUInt16BE(42) : undefined,
    dolbyVision: format === 'dvh1' || format === 'dvhe' || format === 'dav1' || undefined,
  };
  let at = 94;
  for (let i = 0; i < 16 && at + 8 <= b.length; i++) {
    const size = b.readUInt32BE(at);
    const type = b.toString('latin1', at + 4, at + 8);
    if (size < 8) break;
    const body = at + 8;
    if ((type === 'avcC' || type === 'hvcC') && body + 2 <= b.length) {
      draft.profile = type === 'hvcC' ? (b[body + 1] as number) & 0x1f : (b[body + 1] as number);
    } else if (type === 'dvcC' || type === 'dvvC') {
      draft.dolbyVision = true;
    } else if (
      type === 'colr' &&
      body + 10 <= b.length &&
      b.toString('latin1', body, body + 4) === 'nclx'
    ) {
      draft.transfer = b.readUInt16BE(body + 6);
    }
    at += size;
  }
  return videoFacts(MP4_VIDEO_CODECS[format] ?? 'other', draft);
}

/** The packed ISO 639-2/T code of an `mdhd` box: a pad bit, then three 5-bit letters. */
function mdhdLanguage(b: Buffer): string | undefined {
  const at = b[0] === 1 ? 32 : 20;
  if (b.length < at + 2) return undefined;
  const v = b.readUInt16BE(at);
  const code = String.fromCharCode(
    ((v >> 10) & 31) + 0x60,
    ((v >> 5) & 31) + 0x60,
    (v & 31) + 0x60,
  );
  return /^[a-z]{3}$/.test(code) ? code : undefined;
}

async function probeMp4(read: RangeReader): Promise<ProbedTracks> {
  const tracks: Mp4Track[] = [];

  const walk = async (start: number, end: number, current?: Mp4Track): Promise<void> => {
    let at = start;
    for (let i = 0; i < 4096 && at + 8 <= end; i++) {
      const head = await read(at, 16);
      if (head.length < 8) return;
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let header = 8;
      if (size === 1) {
        if (head.length < 16) return;
        size = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (size === 0) {
        size = end - at;
      }
      if (size < header) return;
      const body = at + header;
      const bodyEnd = Math.min(at + size, end);
      if (type === 'trak') {
        const t: Mp4Track = {};
        if (tracks.length < MAX_TRACKS) tracks.push(t);
        await walk(body, bodyEnd, t);
      } else if (MP4_CONTAINERS.has(type)) {
        await walk(body, bodyEnd, current);
      } else if (current && type === 'mdhd') {
        current.code = mdhdLanguage(await read(body, Math.min(40, bodyEnd - body)));
      } else if (current && type === 'hdlr') {
        const b = await read(body, 12);
        if (b.length >= 12) current.handler = b.toString('latin1', 8, 12);
      } else if (current && type === 'stsd') {
        const b = await read(body, current.handler === 'vide' ? Math.min(256, bodyEnd - body) : 40);
        if (current.handler === 'vide') {
          if (b.length >= 44) current.video = mp4Video(b);
        } else if (b.length >= 34) {
          const format = b.toString('latin1', 12, 16);
          current.codec = MP4_CODECS[format] ?? format.trim();
          current.channels = b.readUInt16BE(32) || undefined;
        }
      }
      at += size;
    }
  };

  // Top level: ftyp, then moov and mdat in either order; mdat is skipped by its size.
  let at = 0;
  for (let i = 0; i < 16; i++) {
    const head = await read(at, 16);
    if (head.length < 8) break;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    const header = size === 1 ? 16 : 8;
    if (size === 1) size = Number(head.readBigUInt64BE(8));
    if (type === 'moov') {
      await walk(at + header, at + size);
      const video = tracks.find((t) => t.handler === 'vide')?.video;
      return {
        audio: tracks
          .filter((t) => t.handler === 'soun')
          .map((t) => track({ code: t.code, codec: t.codec, channels: t.channels })),
        ...(video ? { video } : {}),
      };
    }
    if (size < header) break; // size 0 means "to the end", with no moov seen
    at += size;
  }
  throw new UnreadableContainerError('No moov box');
}

// ------------------------------------------------------------------------------------ shared

/** A bounded track; the language is the code as the file wrote it, `und`-like codes dropped. */
function track(t: {
  code?: string | undefined;
  codec?: string | undefined;
  channels?: number | undefined;
  title?: string | undefined;
}): AudioTrack {
  const language = languageName(t.code);
  return {
    ...(language ? { language } : {}),
    ...(t.codec ? { codec: t.codec.slice(0, 20) } : {}),
    ...(t.channels && t.channels > 0 && t.channels <= 32 ? { channels: t.channels } : {}),
    ...(t.title ? { title: t.title } : {}),
  };
}

const NAMES = new Intl.DisplayNames('en', { type: 'language', fallback: 'none' });
const UNSET = new Set(['und', 'zxx', 'mis', 'mul', 'qaa']);

/**
 * The English name AIOStreams would use ("Ukrainian"), from an ISO 639-1/-2 code or a BCP 47 tag.
 * Undefined when the file leaves the language unset or the code is unknown.
 */
export function languageName(code: string | undefined): string | undefined {
  const primary = code?.trim().toLowerCase().split(/[-_]/)[0];
  if (!primary || UNSET.has(primary) || !/^[a-z]{2,3}$/.test(primary)) return undefined;
  try {
    return NAMES.of(primary);
  } catch {
    return undefined;
  }
}

/**
 * The audio tracks and the video facts of a Matroska or MP4 file. Throws `UnreadableContainerError`
 * for anything else (AVI, TS...) or a file whose track list is not near the start (or end, for MP4).
 */
export async function probeTracks(read: RangeReader): Promise<ProbedTracks> {
  const cached = blocked(read);
  const head = await cached(0, 16);
  if (head.length >= 4 && head.readUInt32BE(0) === MKV.ebml) return probeMatroska(cached);
  if (head.length >= 8 && /^(ftyp|moov|mdat|free|skip|wide)$/.test(head.toString('latin1', 4, 8))) {
    return probeMp4(cached);
  }
  // The first bytes tell an error page (text) from a container we do not read (AVI, TS).
  const sample = head.subarray(0, 8);
  throw new UnreadableContainerError(
    `Not Matroska or MP4 (starts ${sample.toString('hex')} "${sample.toString('latin1').replace(/[^\x20-\x7e]/g, '.')}")`,
  );
}
