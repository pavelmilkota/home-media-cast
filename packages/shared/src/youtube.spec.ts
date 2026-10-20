import { describe, expect, it } from 'vitest';
import { parseStartSeconds, parseYouTubeUrl } from './youtube.js';

const ID = 'jNQXAC9IVRw';

describe('parseYouTubeUrl', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}`],
    [`http://m.youtube.com/watch?v=${ID}`],
    [`https://music.youtube.com/watch?v=${ID}`],
    [`https://www.youtube.com/watch?feature=share&v=${ID}&pp=abc`],
    [`https://www.youtube.com/shorts/${ID}`],
    [`https://www.youtube.com/shorts/${ID}/`],
    [`https://www.youtube.com/embed/${ID}`],
    [`https://www.youtube-nocookie.com/embed/${ID}`],
    [`https://www.youtube.com/live/${ID}?feature=share`],
    [`https://www.youtube.com/v/${ID}`],
    [`https://youtu.be/${ID}`],
    [`https://youtu.be/${ID}?si=TrackingParam`],
    [`  https://youtu.be/${ID}  `],
    [`HTTPS://YOUTU.BE/${ID}`],
  ])('accepts %s', (url) => {
    expect(parseYouTubeUrl(url)).toEqual({ videoId: ID });
  });

  it('reads the start time and the playlist', () => {
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=90`)).toEqual({
      videoId: ID,
      startSeconds: 90,
    });
    expect(
      parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&list=PLabcdefghijk123&t=1m30s`),
    ).toEqual({ videoId: ID, startSeconds: 90, listId: 'PLabcdefghijk123' });
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&start=15`)?.startSeconds).toBe(
      15,
    );
  });

  it.each([
    '',
    '   ',
    ID,
    'not a url',
    'ftp://youtu.be/' + ID,
    'javascript:alert(1)',
    `plugin://plugin.video.youtube/play/?video_id=${ID}`,
    'file:///etc/passwd',
    'https://www.youtube.com/',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/watch?v=',
    'https://www.youtube.com/watch?v=short',
    `https://www.youtube.com/watch?v=${ID}x`,
    `https://www.youtube.com/watch?v=${ID}/extra`,
    'https://www.youtube.com/playlist?list=PLabcdefghijk123',
    'https://www.youtube.com/@somechannel',
    `https://www.youtube.com/shorts/${ID}/extra`,
    `https://www.youtube.com/watch?v=${encodeURIComponent(ID + '&x=1')}`,
    `https://www.youtube.com/watch?v=${ID.slice(0, 10)}%0A`,
    `https://evil-youtube.com/watch?v=${ID}`,
    `https://youtube.com.evil.net/watch?v=${ID}`,
    `https://notyoutu.be/${ID}`,
    `https://youtu.be.evil.net/${ID}`,
    `https://user:pass@youtu.be/${ID}`,
    `https://youtu.be:8443/${ID}`,
    `https://127.0.0.1/watch?v=${ID}`,
    `https://youtu.be/${'a'.repeat(5000)}`,
  ])('rejects %j', (url) => {
    expect(parseYouTubeUrl(url)).toBeUndefined();
  });

  it('ignores a bad start time and a bad playlist instead of rejecting the link', () => {
    expect(parseYouTubeUrl(`https://youtu.be/${ID}?t=abc&list=x`)).toEqual({ videoId: ID });
  });

  it('the first v= wins, and only a valid id comes back', () => {
    expect(parseYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&v=zzzzzzzzzzz`)?.videoId).toBe(
      ID,
    );
  });
});

describe('parseStartSeconds', () => {
  it.each([
    ['90', 90],
    ['90s', 90],
    ['1m30s', 90],
    ['1h2m3s', 3723],
    ['2m', 120],
    ['1h', 3600],
  ])('%s -> %i', (raw, expected) => {
    expect(parseStartSeconds(raw)).toBe(expected);
  });

  it.each([null, '', '0', '-5', '1.5', 'abc', '1x', 'm', '99999999', '1h-2m', '10 s'])(
    '%j is not a start time',
    (raw) => {
      expect(parseStartSeconds(raw)).toBeUndefined();
    },
  );
});
