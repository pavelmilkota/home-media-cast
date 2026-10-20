import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, pairDevice, type TestApp } from './testing/test-app.js';

describe('request logging (e2e)', () => {
  let t: TestApp;
  beforeEach(async () => {
    t = await createTestApp();
  });
  afterEach(async () => {
    await t.close();
  });

  it('logs method, redacted path, status and time, but never tokens, codes or links', async () => {
    const token = await pairDevice(t);
    await t.http('POST', '/playback', {
      token,
      body: { kind: 'direct_url', url: 'http://93.184.216.34/a.mp4?token=LINKSECRET' },
    });
    await fetch(`${t.base}/devices?token=QUERYSECRET`, {
      headers: { authorization: `Bearer ${token}` },
    });

    const log = t.logLines.join('\n');
    expect(log).toMatch(/POST \/api\/playback 202 \d+ms/);
    expect(log).toContain('/api/devices?token=***');
    for (const secret of [token, 'LINKSECRET', 'QUERYSECRET', 'Bearer']) {
      expect(log).not.toContain(secret);
    }
    const code = /\d{6}/.exec(
      JSON.stringify(t.kodi.requests.findLast((r) => r.method === 'GUI.ShowNotification')?.params),
    )?.[0];
    expect(log).not.toContain(code);
  });
});
