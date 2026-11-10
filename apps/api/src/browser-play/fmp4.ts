/**
 * Just enough of ISO BMFF (fragmented MP4) to read where a run really starts in the film.
 *
 * With `-copyts` ffmpeg's MP4 muxer keeps every fragment's `tfdt` at 0 and records the film time of
 * the first sample as an empty edit (`moov/trak/edts/elst`, media time -1) in the movie timescale.
 * The start is that empty edit (plus any `tfdt`). Browsers do not agree on edit lists: Chrome's
 * Media Source ignores them, Firefox applies the empty edit and puts a run that starts at 13 min
 * 13 min after `currentTime` 0, where hls.js never looks (the picture froze while hls.js fetched
 * on). So the player gets the init segment without edit lists (`withoutEditLists`): `currentTime`
 * 0 is the first sample everywhere. Bounded and defensive: anything malformed gives `undefined`.
 */

interface Box {
  type: string;
  /** Payload start and end (after the header). */
  start: number;
  end: number;
}

function* boxes(buf: Buffer, start: number, end: number): Generator<Box> {
  let at = start;
  let guard = 0;
  while (at + 8 <= end && guard++ < 10_000) {
    let size = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    let header = 8;
    if (size === 1) {
      if (at + 16 > end) return;
      const big = buf.readBigUInt64BE(at + 8);
      if (big > BigInt(end - at)) return;
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < header || at + size > end) return;
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

const child = (buf: Buffer, box: Box, type: string): Box | undefined => {
  for (const b of boxes(buf, box.start, box.end)) if (b.type === type) return b;
  return undefined;
};

/** `version` 1 boxes carry 64-bit times. */
const time = (buf: Buffer, at: number, wide: boolean): number =>
  wide ? Number(buf.readBigUInt64BE(at)) : buf.readUInt32BE(at);

interface TrackInit {
  timescale: number;
  /** The empty edit at the start of the track, in milliseconds (0 without one). */
  delayMs: number;
}

/** Track id → timescale and initial delay, from an init segment. */
export function readInit(init: Buffer): Map<number, TrackInit> {
  const out = new Map<number, TrackInit>();
  try {
    const moov = [...boxes(init, 0, init.length)].find((b) => b.type === 'moov');
    if (!moov) return out;
    const mvhd = child(init, moov, 'mvhd');
    const movieScale = mvhd
      ? init.readUInt32BE(mvhd.start + (init[mvhd.start] === 1 ? 20 : 12))
      : 0;
    for (const trak of boxes(init, moov.start, moov.end)) {
      if (trak.type !== 'trak') continue;
      const tkhd = child(init, trak, 'tkhd');
      const mdia = child(init, trak, 'mdia');
      const mdhd = mdia && child(init, mdia, 'mdhd');
      if (!tkhd || !mdhd) continue;
      const id = init.readUInt32BE(tkhd.start + (init[tkhd.start] === 1 ? 20 : 12));
      const timescale = init.readUInt32BE(mdhd.start + (init[mdhd.start] === 1 ? 20 : 12));
      let delayMs = 0;
      const edts = child(init, trak, 'edts');
      const elst = edts && child(init, edts, 'elst');
      if (elst && movieScale > 0 && init.readUInt32BE(elst.start + 4) > 0) {
        const wide = init[elst.start] === 1;
        const duration = time(init, elst.start + 8, wide);
        const media = wide
          ? init.readBigInt64BE(elst.start + 16)
          : BigInt(init.readInt32BE(elst.start + 12));
        if (media === -1n) delayMs = (duration / movieScale) * 1000;
      }
      if (timescale > 0) out.set(id, { timescale, delayMs });
    }
  } catch {
    /* malformed: whatever was read so far */
  }
  return out;
}

/**
 * The film time, in milliseconds, at the run's `currentTime` 0: the earliest track start of the
 * first fragment in `segment`, or undefined when it cannot be read.
 */
export function runStartMs(init: Buffer, segment: Buffer): number | undefined {
  const tracks = readInit(init);
  let best: number | undefined;
  try {
    for (const moof of boxes(segment, 0, segment.length)) {
      if (moof.type !== 'moof') continue;
      for (const traf of boxes(segment, moof.start, moof.end)) {
        if (traf.type !== 'traf') continue;
        const tfhd = child(segment, traf, 'tfhd');
        const tfdt = child(segment, traf, 'tfdt');
        if (!tfhd || !tfdt) continue;
        const track = tracks.get(segment.readUInt32BE(tfhd.start + 4));
        if (!track) continue;
        const decode = time(segment, tfdt.start + 4, segment[tfdt.start] === 1);
        const ms = track.delayMs + (decode / track.timescale) * 1000;
        if (Number.isFinite(ms) && (best === undefined || ms < best)) best = ms;
      }
      break; // the first fragment is the start
    }
  } catch {
    return undefined;
  }
  return best === undefined ? undefined : Math.round(best);
}

/** A box's header with a new 32-bit size, followed by `body`. */
const rebox = (type: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
};

/**
 * The init segment without `moov/trak/edts` (edit lists), every other box byte for byte; see the
 * header for why. Returns `undefined` when the segment cannot be read with certainty (a box size
 * that does not add up, a 64-bit size on a box to rewrite), so the caller can say so.
 */
export function withoutEditLists(init: Buffer): Buffer | undefined {
  try {
    const top = [...boxes(init, 0, init.length)];
    const covered = (list: Box[], start: number, end: number, header = 8) =>
      list.length > 0 &&
      list[0]!.start - header === start &&
      list.every((b, i) => i === 0 || b.start - header === list[i - 1]!.end) &&
      list[list.length - 1]!.end === end;
    if (!covered(top, 0, init.length)) return undefined;
    const moov = top.find((b) => b.type === 'moov');
    if (!moov || init.readUInt32BE(moov.start - 8) === 1) return undefined;
    const children = [...boxes(init, moov.start, moov.end)];
    if (!covered(children, moov.start, moov.end)) return undefined;
    const raw = (b: Box) => init.subarray(b.start - 8, b.end);
    const moovBody = children.map((c) => {
      if (c.type !== 'trak') return raw(c);
      if (init.readUInt32BE(c.start - 8) === 1) throw new Error('64-bit trak');
      const parts = [...boxes(init, c.start, c.end)];
      if (!covered(parts, c.start, c.end)) throw new Error('malformed trak');
      return rebox('trak', Buffer.concat(parts.filter((p) => p.type !== 'edts').map(raw)));
    });
    return Buffer.concat(
      top.map((b) => (b === moov ? rebox('moov', Buffer.concat(moovBody)) : raw(b))),
    );
  } catch {
    return undefined;
  }
}
