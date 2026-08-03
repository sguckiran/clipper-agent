import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '../config/index.js';
import { BrowserPublisher, defaultPublisherScriptPath } from './browser.js';

const MANAGED_KEYS = ['CLIPPER_DATA_DIR', 'CLIPPER_PUBLISH_PLATFORMS'];

describe('BrowserPublisher', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of MANAGED_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    resetConfigCache();
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetConfigCache();
  });

  it('points at the in-repo Python bridge by default', () => {
    expect(defaultPublisherScriptPath()).toMatch(
      /python[\\/]clipper_publisher[\\/]browser_publisher\.py$/,
    );
  });

  it('sends a publish request to the bridge and parses results', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'clipper-publisher-'));
    const fakeScript = join(dir, 'fake-publisher.mjs');
    await writeFile(
      fakeScript,
      [
        "import { stdin } from 'node:process';",
        "let raw = '';",
        'for await (const chunk of stdin) raw += chunk;',
        'const payload = JSON.parse(raw);',
        'console.log(JSON.stringify({ ok: true, results: payload.platforms.map((p) => ({ platform: p, status: "published" })) }));',
      ].join('\n'),
      'utf8',
    );

    const publisher = new BrowserPublisher({
      python: process.execPath,
      scriptPath: fakeScript,
      dataDir: dir,
    });

    const response = await publisher.publishFile('C:\\clips\\one.mp4', 'caption', ['tiktok']);

    expect(response).toEqual({
      ok: true,
      results: [{ platform: 'tiktok', status: 'published' }],
    });
  });
});
