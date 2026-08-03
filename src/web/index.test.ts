import { describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { resetConfigCache } from '../config/index.js';
import type { ClipCandidate } from '../core/types.js';
import { createWebServer, hashPassword, qualityMeter, verifyPassword } from './index.js';

const candidate = (over: Partial<ClipCandidate>): ClipCandidate => ({
  id: 'c',
  sourceId: 's',
  startSec: 0,
  endSec: 20,
  score: 90,
  reason: 'r',
  transcriptText: 't',
  funny: 90,
  hook: 90,
  pocket: 90,
  coherence: 90,
  ...over,
});

describe('qualityMeter', () => {
  it('uses the weakest required dimension as an AND gate', () => {
    expect(qualityMeter(candidate({ score: 95, funny: 92, hook: 88, coherence: 91 }))).toBe(88);
    expect(qualityMeter(candidate({ coherence: 42 }))).toBe(42);
    expect(qualityMeter(candidate({ funny: 30 }))).toBe(30);
  });

  it('does not let a high virality score hide missing coherence', () => {
    expect(qualityMeter(candidate({ score: 99, funny: 99, hook: 99, coherence: 55 }))).toBe(55);
  });
});

function http(
  port: number,
  opts: { path: string; method?: string; body?: string; headers?: Record<string, string> },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        port,
        host: '127.0.0.1',
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body) req.end(opts.body);
    else req.end();
  });
}

async function withServer<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server = createWebServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  try {
    return await fn(address.port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe('web auth', () => {
  it('hashes and verifies passwords', () => {
    const encoded = hashPassword('correct horse');
    expect(verifyPassword('correct horse', encoded)).toBe(true);
    expect(verifyPassword('wrong', encoded)).toBe(false);
  });

  it('redirects unauthenticated users and accepts the password', async () => {
    const saved = {
      password: process.env.CLIPPER_WEB_PASSWORD,
      hash: process.env.CLIPPER_WEB_PASSWORD_HASH,
      secret: process.env.CLIPPER_WEB_SESSION_SECRET,
    };
    process.env.CLIPPER_WEB_PASSWORD = 'secret';
    delete process.env.CLIPPER_WEB_PASSWORD_HASH;
    process.env.CLIPPER_WEB_SESSION_SECRET = 'test-session-secret';
    resetConfigCache();
    try {
      await withServer(async (port) => {
        const root = await http(port, { path: '/' });
        expect(root.status).toBe(302);
        expect(root.headers.location).toBe('/login');

        const bad = await http(port, {
          path: '/login',
          method: 'POST',
          body: 'password=wrong',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(bad.status).toBe(401);

        const ok = await http(port, {
          path: '/login',
          method: 'POST',
          body: 'password=secret',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        });
        expect(ok.status).toBe(302);
        const cookie = ok.headers['set-cookie']?.[0];
        expect(cookie).toContain('clipper_session=');
        expect(cookie).toContain('HttpOnly');

        const api = await http(port, { path: '/api/jobs', headers: { cookie: cookie ?? '' } });
        expect(api.status).toBe(200);
      });
    } finally {
      if (saved.password === undefined) delete process.env.CLIPPER_WEB_PASSWORD;
      else process.env.CLIPPER_WEB_PASSWORD = saved.password;
      if (saved.hash === undefined) delete process.env.CLIPPER_WEB_PASSWORD_HASH;
      else process.env.CLIPPER_WEB_PASSWORD_HASH = saved.hash;
      if (saved.secret === undefined) delete process.env.CLIPPER_WEB_SESSION_SECRET;
      else process.env.CLIPPER_WEB_SESSION_SECRET = saved.secret;
      resetConfigCache();
    }
  });
});
