/** One subtitle cue; `start` and `end` are seconds on the run's own clock (`video.currentTime`). */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

const TIME = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;

function seconds(stamp: string): number | undefined {
  const m = TIME.exec(stamp.trim());
  if (!m) return undefined;
  const [, h, min, s, ms] = m;
  return (
    Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s) + Number((ms ?? '0').padEnd(3, '0')) / 1000
  );
}

/** Markup that has no place in a plain-text overlay: tags and ASS override blocks. */
const clean = (line: string) =>
  line
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();

/**
 * Reads WebVTT as `ffmpeg` writes it (`MM:SS.mmm` below an hour, `HH:MM:SS.mmm` above). Tolerant:
 * anything it does not understand is skipped, and a cue still being written is simply absent.
 */
export function parseVtt(source: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of source.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [from, to] = (lines[at] as string).split('-->');
    const start = seconds(from ?? '');
    const end = seconds((to ?? '').trim().split(/\s+/)[0] ?? '');
    if (start === undefined || end === undefined || end <= start) continue;
    const text = lines
      .slice(at + 1)
      .map(clean)
      .filter(Boolean)
      .join('\n');
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

/** The text to show at `time`: every cue that is on, in file order. */
export function cueTextAt(cues: readonly Cue[], time: number): string {
  return cues
    .filter((c) => c.start <= time && time < c.end)
    .map((c) => c.text)
    .join('\n');
}
